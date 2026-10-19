"""Canonical computer naming: real browser authority, preserved temporary stores."""
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest

import tli_state as S
import node_settings
from routers import system_routes as system, mesh_routes as mesh


CASES = [('/system/node/name', 'name'), ('/device/nickname', 'nickname'),
         ('/mesh/node/identity', 'node_name')]
NEW_NAME = 'PRIVATE renamed workstation'


@pytest.fixture
def naming_host(tmp_path, monkeypatch):
    root = tmp_path / 'data'
    mesh_dir = root / 'mesh'
    mesh_dir.mkdir(parents=True)
    node_path = mesh_dir / 'node_config.json'
    node = {'node_id': 'canonical-saved-id', 'node_name': 'PRIVATE previous name', 'role': 'host',
            'mesh_status': 'approved', 'host_device_id': 'retained-host', 'host_name': 'PRIVATE host name',
            'host_address': '192.0.2.10:8000', 'created_at': '2026-10-01T00:00:00Z',
            'updated_at': '2026-10-01T00:00:00Z', 'prefer_mesh_ai': True, 'mesh_ai_cpu_threshold': 85,
            'future': {'keep': [1, True, None], 'secret': 'PRIVATE additive metadata'}}
    node_path.write_text(json.dumps(node), encoding='utf-8')
    devices_path = root / 'devices.json'
    devices_path.write_bytes(b'{"PRIVATE legacy registry":damaged')
    monkeypatch.setattr(S, 'DATA_DIR', str(root))
    monkeypatch.setattr(S, 'MESH_DATA_DIR', mesh_dir)
    monkeypatch.setattr(S, 'NODE_CONFIG_PATH', node_path)
    monkeypatch.setattr(S, 'DEVICES_FILE', str(devices_path))
    monkeypatch.setattr(S, 'PIN_CONFIG_FILE', root / 'tli_pin.json')
    monkeypatch.setattr(S, '_active_sessions', {})
    monkeypatch.setattr(node_settings, '_UNCERTAIN', set())
    S.save_pin_config('a' * 64, 'b' * 64)
    token = S.create_session_token('owner')
    blocked = {}
    for name in ('load_node_config', 'save_node_config', 'load_devices', 'save_devices', 'log_debug'):
        blocked[name] = Mock(side_effect=AssertionError('Naming reached legacy state or private logging'))
        monkeypatch.setattr(S, name, blocked[name])
    app = FastAPI()
    app.include_router(system.router); app.include_router(mesh.router)
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
        if mode == 'cross-origin': client.headers['Origin'] = 'https://foreign.invalid'
        if mode == 'same-site': client.headers['Sec-Fetch-Site'] = 'same-site'
        if mode == 'missing-origin': del client.headers['Origin']
        if mode == 'proxy': client.headers['Forwarded'] = 'for=127.0.0.1'
        if mode == 'peer': client.headers['X-TLI-Peer-Id'] = 'synthetic-peer'
        if mode == 'bearer': client.headers['Authorization'] = 'Bearer synthetic-companion'
        clients.append(client)
        return client
    yield SimpleNamespace(root=root, token=token, node=node, node_path=node_path, devices_path=devices_path,
                          browser=browser, blocked=blocked)
    for client in clients: client.close()
    for operation in blocked.values(): operation.assert_not_called()
    assert devices_path.read_bytes() == b'{"PRIVATE legacy registry":damaged'


def send(client, case, name=NEW_NAME):
    path, field = case
    return client.post(path, json={field: name})


@pytest.mark.parametrize('case', CASES)
@pytest.mark.parametrize('mode,status', [('anonymous', 401), ('revoked', 401), ('expired', 401),
    ('pin-off-stale', 401), ('pin-off-lan', 403), ('remote-http', 403), ('cross-origin', 403),
    ('same-site', 403), ('missing-origin', 403), ('proxy', 403), ('peer', 403), ('bearer', 403), ('unavailable', 503)])
def test_name_change_denied_before_private_store_access(naming_host, monkeypatch, case, mode, status):
    f = naming_host
    before = f.node_path.read_bytes()
    store = Mock(side_effect=AssertionError('Denied request reached node store'))
    monkeypatch.setattr(S, 'update_node_settings', store)
    if mode == 'unavailable': S.PIN_CONFIG_FILE.write_bytes(b'{"PRIVATE":damaged')
    response = send(f.browser(mode), case)
    assert response.status_code == status, response.text
    assert response.headers['cache-control'] == 'no-store' and 'PRIVATE' not in response.text
    store.assert_not_called()
    assert f.node_path.read_bytes() == before


@pytest.mark.parametrize('case', CASES)
@pytest.mark.parametrize('mode', ['pin-local', 'pin-https', 'open-local'])
def test_all_name_aliases_update_only_canonical_node_settings(naming_host, case, mode):
    f = naming_host
    response = send(f.browser(mode), case, '  ' + NEW_NAME + '  ')
    assert response.status_code == 200, response.text
    assert response.headers['cache-control'] == 'no-store'
    saved = json.loads(f.node_path.read_bytes())
    assert saved['node_name'] == NEW_NAME and saved['updated_at'] != f.node['updated_at']
    assert {key: value for key, value in saved.items() if key not in {'node_name', 'updated_at'}} == {
        key: value for key, value in f.node.items() if key not in {'node_name', 'updated_at'}}
    data = response.json()
    assert data['node_id'] == f.node['node_id']
    if case[1] == 'nickname':
        assert data == {'status': 'ok', 'device_id': 'default-device', 'node_id': f.node['node_id'], 'nickname': NEW_NAME}
    elif case[1] == 'name':
        assert data == {'ok': True, 'node_id': f.node['node_id'], 'node_name': NEW_NAME}
    else:
        assert data == {'ok': True, 'node_id': f.node['node_id'], 'node_name': NEW_NAME, 'role': 'host'}


def test_mesh_name_and_role_are_one_preserving_update(naming_host):
    f = naming_host
    response = f.browser().post('/mesh/node/identity', json={'node_name': NEW_NAME, 'role': ' MeMbEr '})
    assert response.status_code == 200, response.text
    assert response.json() == {'ok': True, 'node_id': f.node['node_id'], 'node_name': NEW_NAME, 'role': 'member'}
    saved = json.loads(f.node_path.read_bytes())
    assert saved['node_name'] == NEW_NAME and saved['role'] == 'member'
    assert {k: v for k, v in saved.items() if k not in {'node_name', 'role', 'updated_at'}} == {
        k: v for k, v in f.node.items() if k not in {'node_name', 'role', 'updated_at'}}


def test_mesh_role_only_preserves_name_and_no_fields_preserves_original_bytes(naming_host):
    f = naming_host
    client = f.browser()
    before = f.node_path.read_bytes()
    empty = client.post('/mesh/node/identity', json={})
    assert empty.status_code == 200 and f.node_path.read_bytes() == before
    response = client.post('/mesh/node/identity', json={'role': 'standalone'})
    assert response.status_code == 200
    saved = json.loads(f.node_path.read_bytes())
    assert saved['node_name'] == f.node['node_name'] and saved['role'] == 'standalone'


@pytest.mark.parametrize('case', CASES)
def test_unchanged_name_does_not_rewrite_settings(naming_host, case):
    f = naming_host
    before = f.node_path.read_bytes()
    response = send(f.browser(), case, f.node['node_name'])
    assert response.status_code == 200 and f.node_path.read_bytes() == before


@pytest.mark.parametrize('case', CASES)
@pytest.mark.parametrize('value', ['A' * 64, '🪕' * 64])
def test_supported_64_character_names_are_preserved_without_truncation(naming_host, case, value):
    response = send(naming_host.browser(), case, value)
    assert response.status_code == 200, response.text
    assert json.loads(naming_host.node_path.read_bytes())['node_name'] == value


@pytest.mark.parametrize('case', CASES)
@pytest.mark.parametrize('value,status', [('', 400), ('   ', 400), ('PRIVATE\nname', 400),
    ('PRIVATE\x00name', 400), ('\nPRIVATE name', 400), ('PRIVATE\u0085name', 400),
    ('PRIVATE' + 'a' * 65, 400), ('PRIVATE' + 'a' * 257, 422),
    (True, 422), (123, 422), (['PRIVATE'], 422), ({'PRIVATE': 'value'}, 422)])
def test_invalid_names_are_redacted_and_leave_original_bytes(naming_host, case, value, status):
    f = naming_host
    before = f.node_path.read_bytes()
    response = send(f.browser(), case, value)
    assert response.status_code == status, response.text
    assert response.headers['cache-control'] == 'no-store' and 'PRIVATE' not in response.text
    assert f.node_path.read_bytes() == before


@pytest.mark.parametrize('case', CASES)
def test_malformed_json_never_echoes_private_name(naming_host, case):
    f = naming_host
    before = f.node_path.read_bytes()
    response = f.browser().post(case[0], content='{"' + case[1] + '":"PRIVATE incomplete',
                                headers={'Content-Type': 'application/json'})
    assert response.status_code == 422, response.text
    assert response.headers['cache-control'] == 'no-store' and 'PRIVATE' not in response.text
    assert f.node_path.read_bytes() == before


@pytest.mark.parametrize('role,status', [('PRIVATE invalid', 400), ('PRIVATE' * 5, 422), (False, 422)])
def test_invalid_role_cannot_commit_other_name_field(naming_host, role, status):
    f = naming_host
    before = f.node_path.read_bytes()
    response = f.browser().post('/mesh/node/identity', json={'node_name': NEW_NAME, 'role': role})
    assert response.status_code == status, response.text
    assert response.headers['cache-control'] == 'no-store' and 'PRIVATE' not in response.text
    assert f.node_path.read_bytes() == before


@pytest.mark.parametrize('case', CASES)
@pytest.mark.parametrize('damage', [b'{"PRIVATE":broken', b'[]', b'{}',
    b'{"node_id":"PRIVATE old","node_id":"PRIVATE new"}'])
def test_damaged_saved_identity_is_preserved(naming_host, case, damage):
    f = naming_host
    f.node_path.write_bytes(damage)
    response = send(f.browser(), case)
    assert response.status_code == 503, response.text
    assert response.headers['cache-control'] == 'no-store' and 'PRIVATE' not in response.text
    assert f.node_path.read_bytes() == damage


@pytest.mark.parametrize('case', CASES)
def test_missing_identity_is_not_created_by_a_rename(naming_host, case):
    f = naming_host
    f.node_path.unlink()
    response = send(f.browser('open-local'), case)
    assert response.status_code == 503, response.text
    assert response.headers['cache-control'] == 'no-store'
    assert not f.node_path.exists()


def deny(f, change):
    if change == 'revoke': S.revoke_session_token(f.token)
    elif change == 'owner': S._active_sessions[f.token]['user_id'] = 'different-owner'
    elif change == 'epoch': S.revoke_all_sessions()
    else: S.PIN_CONFIG_FILE.write_bytes(b'{"PRIVATE security":damaged')


@pytest.mark.parametrize('case', CASES)
@pytest.mark.parametrize('change', ['revoke', 'owner', 'epoch', 'damage'])
@pytest.mark.parametrize('error', [False, True])
def test_name_response_rechecks_captured_authority(naming_host, monkeypatch, case, change, error):
    f = naming_host
    client = f.browser('open-local' if change == 'epoch' else 'pin-local')
    before = f.node_path.read_bytes()
    def save(*args, check=None, **kwargs):
        assert callable(check)
        check()
        deny(f, change)
        if error: raise RuntimeError('PRIVATE write failed')
        return {'node_id': f.node['node_id'], 'node_name': NEW_NAME, 'role': 'host'}
    monkeypatch.setattr(S, 'update_node_settings', save)
    response = send(client, case)
    assert response.status_code == (503 if change == 'damage' else 401), response.text
    assert response.headers['cache-control'] == 'no-store' and 'PRIVATE' not in response.text
    assert f.node_path.read_bytes() == before


@pytest.mark.parametrize('case', CASES)
@pytest.mark.parametrize('mode', ['anonymous', 'pin-off-lan', 'bearer', 'pin-https', 'open-local'])
def test_effective_main_naming_paths_keep_browser_admission(naming_host, monkeypatch, app, case, mode):
    import companion_auth
    f = naming_host
    before = f.node_path.read_bytes()
    if mode == 'bearer': monkeypatch.setattr(companion_auth, 'credential_owner', lambda _: 'owner')
    response = send(f.browser(mode, target=app), case)
    status = 200 if mode in {'pin-https', 'open-local'} else 401 if mode == 'anonymous' else 403
    assert response.status_code == status, response.text
    assert response.headers['cache-control'] == 'no-store'
    if status != 200: assert f.node_path.read_bytes() == before


@pytest.mark.parametrize('case', CASES)
def test_effective_main_invalid_bearer_never_falls_back_to_cookie(naming_host, monkeypatch, app, case):
    import companion_auth
    f = naming_host
    before = f.node_path.read_bytes()
    def invalid(_): raise HTTPException(401, 'Credential revoked')
    monkeypatch.setattr(companion_auth, 'credential_owner', invalid)
    response = send(f.browser('bearer', target=app), case)
    assert response.status_code == 401 and response.headers['cache-control'] == 'no-store'
    assert f.node_path.read_bytes() == before


@pytest.mark.parametrize('case', CASES)
@pytest.mark.parametrize('stage_number', [1, 2])
@pytest.mark.parametrize('change', ['revoke', 'epoch'])
def test_revocation_during_staging_prevents_node_commit(naming_host, monkeypatch, case, stage_number, change):
    f = naming_host
    client = f.browser('open-local' if change == 'epoch' else 'pin-local')
    before = f.node_path.read_bytes()
    fsync = node_settings.os.fsync
    calls = []
    def revoke_after_fsync(fd):
        fsync(fd)
        calls.append(fd)
        if len(calls) == stage_number: deny(f, change)
    monkeypatch.setattr(node_settings.os, 'fsync', revoke_after_fsync)
    response = send(client, case)
    assert response.status_code == 401, response.text
    assert response.headers['cache-control'] == 'no-store' and 'PRIVATE' not in response.text
    assert len(calls) == stage_number and f.node_path.read_bytes() == before
    assert not list(f.node_path.parent.glob('.tli-node-settings-*'))
    assert str(f.node_path) not in node_settings._UNCERTAIN


@pytest.mark.parametrize('case', CASES)
@pytest.mark.parametrize('change', ['revoke', 'damage'])
def test_confirmed_commit_survives_denied_disclosure(naming_host, monkeypatch, case, change):
    f = naming_host
    client = f.browser()
    replace = node_settings.os.replace
    calls = []
    def replace_then_revoke(source, destination):
        assert Path(destination) == f.node_path
        replace(source, destination)
        calls.append(destination)
        deny(f, change)
    monkeypatch.setattr(node_settings.os, 'replace', replace_then_revoke)
    response = send(client, case)
    assert response.status_code == (503 if change == 'damage' else 401), response.text
    assert response.headers['cache-control'] == 'no-store' and 'PRIVATE' not in response.text
    assert len(calls) == 1
    saved = json.loads(f.node_path.read_bytes())
    assert saved['node_name'] == NEW_NAME and saved['node_id'] == f.node['node_id']
    assert saved['future'] == f.node['future']
    assert str(f.node_path) not in node_settings._UNCERTAIN
    assert not list(f.node_path.parent.glob('.tli-node-settings-*'))
    assert S.read_node_config().node_name == NEW_NAME


@pytest.mark.parametrize('case', CASES)
@pytest.mark.parametrize('replacement_landed', [False, True])
def test_uncertain_commit_preserves_versions_and_blocks_retry(naming_host, monkeypatch, case, replacement_landed):
    import base64
    f = naming_host
    client = f.browser()
    before = f.node_path.read_bytes()
    replace = node_settings.os.replace
    calls = []
    def fail_replace(source, destination):
        assert Path(destination) == f.node_path
        calls.append(destination)
        if replacement_landed: replace(source, destination)
        raise OSError('PRIVATE uncertain save')
    monkeypatch.setattr(node_settings.os, 'replace', fail_replace)
    response = send(client, case)
    assert response.status_code == 503, response.text
    assert response.headers['cache-control'] == 'no-store' and 'PRIVATE' not in response.text
    assert len(calls) == 1 and str(f.node_path) in node_settings._UNCERTAIN
    retained = list(f.node_path.parent.glob('.tli-node-settings-*.recovery.json'))
    assert len(retained) == 1
    recovery = json.loads(retained[0].read_bytes())
    assert base64.b64decode(recovery['before']['base64']) == before
    assert json.loads(base64.b64decode(recovery['after']['base64']))['node_name'] == NEW_NAME
    after = f.node_path.read_bytes()
    assert (after != before) is replacement_landed
    repeated = send(client, case, 'PRIVATE another requested name')
    assert repeated.status_code == 503 and len(calls) == 1
    assert f.node_path.read_bytes() == after and retained[0].exists()
    with pytest.raises(HTTPException) as unavailable: S.read_node_config()
    assert unavailable.value.status_code == 503
