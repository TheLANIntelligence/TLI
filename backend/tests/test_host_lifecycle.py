"""Managed desktop lifecycle under synthetic ownership; never stops this host."""
from types import SimpleNamespace
import copy
import os

import pytest

import host_control as H
import host_launcher as L
import host_lifecycle as lifecycle


@pytest.fixture
def desktop(tmp_path, monkeypatch):
    root = tmp_path / 'installation'
    (root / 'backend').mkdir(parents=True)
    (root / 'backend' / 'host_lifecycle.py').write_text('# synthetic fixed helper')
    identity = H.installation(root, create=True)
    child = {'pid': os.getpid(), 'created_at': 12.5, 'script': 'main.py'}
    helper = {'pid': os.getpid(), 'created_at': 15.5, 'script': 'host_lifecycle.py'}
    state = {'main.py': 'running', 'host_lifecycle.py': 'running'}
    settings = {'current_settings': {'host': '127.0.0.1', 'port': 8000, 'https': False},
                'next_settings': {'host': '127.0.0.1', 'port': 8000, 'https': False}}
    clock = [1000.0]
    monkeypatch.setattr(lifecycle, 'time', SimpleNamespace(time=lambda: clock[0], monotonic=lambda: clock[0], sleep=lambda seconds: clock.__setitem__(0, clock[0] + seconds)))
    monkeypatch.setenv('TLI_MANAGED_CHILD', identity['installation_id'])
    monkeypatch.setattr(L, 'recorded_backend_children', lambda _: [dict(child)])
    monkeypatch.setattr(L, 'process_generation_state', lambda _, row: state.get(row['script'], 'unknown'))
    monkeypatch.setattr(L, 'python_path', lambda *_args, **_kwargs: root / 'backend/.venv/Scripts/pythonw.exe')
    monkeypatch.setattr(lifecycle, '_settings', lambda _: copy.deepcopy(settings))
    monkeypatch.setattr(lifecycle.startup_config, 'resolve', lambda _root, environ=None: {'effective_next': copy.deepcopy(settings['next_settings' if environ == {} else 'current_settings'])})
    spawned, stopped, launched = [], [], []
    def spawn(actual_root, script, arguments=(), **kwargs):
        assert actual_root == root and script == 'host_lifecycle.py'
        assert arguments[0] == '--request'
        spawned.append((script, arguments, kwargs))
        return dict(helper)
    def stop(actual_root, **kwargs):
        assert actual_root == root
        assert kwargs['expected_child'] == child
        assert kwargs['settings'] == settings['current_settings']
        stopped.append(kwargs)
        state['main.py'] = 'exited'
        return {'stopped': True}
    def launch(actual_root, **kwargs):
        assert actual_root == root and kwargs['open_browser'] is False
        assert state['main.py'] == 'exited', 'Restart must wait for exact old generation exit'
        assert kwargs['settings'] == settings['next_settings']
        launched.append(kwargs)
        return {'backend_state': 'running'}
    monkeypatch.setattr(L, 'spawn_fixed', spawn)
    monkeypatch.setattr(L, 'stop_owned_backend', stop)
    monkeypatch.setattr(L, 'launch', launch)
    return SimpleNamespace(root=root, identity=identity, child=child, helper=helper, state=state,
                           settings=settings, clock=clock, spawned=spawned, stopped=stopped, launched=launched)


def prepare(desktop, action='restart', principal='owner/session'):
    preview = lifecycle.preview(desktop.root, principal, action)
    request_id = 'a' * 32
    receipt = lifecycle.confirm(desktop.root, principal, preview['preview_id'], request_id)
    return preview, receipt, request_id


def test_capabilities_require_current_managed_process_and_fixed_helper(desktop, monkeypatch):
    result = lifecycle.capabilities(desktop.root)
    assert result['available'] and result['capabilities'] == {'restart': True, 'quit': True}
    assert not desktop.spawned and not desktop.stopped
    monkeypatch.delenv('TLI_MANAGED_CHILD')
    result = lifecycle.capabilities(desktop.root)
    assert not result['available'] and not result['managed']
    assert result['capabilities'] == {'restart': False, 'quit': False}


@pytest.mark.parametrize('ownership', ['unrecorded', 'wrong_pid', 'unconfirmed', 'duplicate'])
def test_unmanaged_or_ambiguous_process_is_never_adopted(desktop, monkeypatch, ownership):
    if ownership == 'unrecorded':
        monkeypatch.setattr(L, 'recorded_backend_children', lambda _: [])
    elif ownership == 'wrong_pid':
        monkeypatch.setattr(L, 'recorded_backend_children', lambda _: [{**desktop.child, 'pid': 123456}])
    elif ownership == 'duplicate':
        monkeypatch.setattr(L, 'recorded_backend_children', lambda _: [desktop.child, {**desktop.child, 'pid': 123456}])
    else:
        desktop.state['main.py'] = 'unknown'
    assert not lifecycle.capabilities(desktop.root)['available']
    with pytest.raises(H.HostControlError):
        lifecycle.preview(desktop.root, 'owner/session', 'quit')
    assert not desktop.spawned and not desktop.stopped


def test_preview_and_confirmation_do_not_spawn_or_stop_before_dispatch(desktop):
    preview, receipt, ident = prepare(desktop)
    assert preview['expires_at'] == desktop.clock[0] + 60
    assert preview['action'] == 'restart' and preview['consequences']
    assert receipt['accepted'] and receipt['status'] == 'accepted'
    assert not desktop.spawned and not desktop.stopped and not desktop.launched
    assert lifecycle.receipt(desktop.root, 'owner/session', ident)['status'] == 'accepted'
    serialized = H.path_for(desktop.root, 'lifecycle.json').read_text()
    assert 'owner/session' not in serialized


@pytest.mark.parametrize('change', ['expired', 'session', 'settings', 'generation'])
def test_confirmation_binds_session_generation_settings_and_expiry(desktop, change):
    preview = lifecycle.preview(desktop.root, 'owner/session', 'restart')
    principal = 'owner/session'
    if change == 'expired': desktop.clock[0] += 61
    elif change == 'session': principal = 'owner/new-session'
    elif change == 'settings': desktop.settings['next_settings']['port'] = 8002
    else: desktop.child['created_at'] += 1
    with pytest.raises(H.HostControlError):
        lifecycle.confirm(desktop.root, principal, preview['preview_id'], 'a' * 32)
    assert not desktop.spawned and not desktop.stopped


def test_confirm_and_dispatch_are_idempotent_and_only_one_operation_is_active(desktop):
    preview, first, ident = prepare(desktop)
    second = lifecycle.confirm(desktop.root, 'owner/session', preview['preview_id'], ident)
    assert second['duplicate'] and first['request_id'] == second['request_id']
    with pytest.raises(H.HostControlError): lifecycle.preview(desktop.root, 'owner/second', 'quit')
    with pytest.raises(H.HostControlError): lifecycle.confirm(desktop.root, 'owner/session', 'b' * 32, ident)
    with pytest.raises(H.HostControlError): lifecycle.receipt(desktop.root, 'owner/second', ident)
    lifecycle.dispatch(desktop.root, 'owner/session', ident)
    duplicate = lifecycle.dispatch(desktop.root, 'owner/session', ident)
    assert duplicate['duplicate'] and len(desktop.spawned) == 1
    assert not desktop.stopped


@pytest.mark.parametrize('action', ['restart', 'quit'])
def test_worker_requests_graceful_exit_then_restarts_without_opening_browser(desktop, action):
    _, _, ident = prepare(desktop, action)
    lifecycle.dispatch(desktop.root, 'owner/session', ident)
    assert lifecycle.run(desktop.root, ident)
    assert len(desktop.stopped) == 1 and len(desktop.launched) == int(action == 'restart')
    final = lifecycle.receipt(desktop.root, 'owner/session', ident)
    assert final['status'] == 'completed' and final['backend_exit_confirmed']
    assert lifecycle.run(desktop.root, ident) is False
    assert len(desktop.stopped) == 1


def test_changed_saved_address_uses_live_address_for_stop_and_reviewed_saved_for_start(desktop):
    desktop.settings['next_settings'] = {'host': '127.0.0.1', 'port': 8443, 'https': True}
    preview, _, ident = prepare(desktop)
    assert preview['current_url'] == 'http://127.0.0.1:8000'
    assert preview['next_url'] == 'https://127.0.0.1:8443'
    lifecycle.dispatch(desktop.root, 'owner/session', ident)
    assert lifecycle.run(desktop.root, ident)
    assert desktop.stopped[0]['settings']['port'] == 8000
    assert desktop.launched[0]['settings']['port'] == 8443


@pytest.mark.parametrize('outcome', ['timeout', 'unknown', 'still_running'])
def test_unconfirmed_exit_never_restarts_or_forces_termination(desktop, monkeypatch, outcome):
    _, _, ident = prepare(desktop)
    lifecycle.dispatch(desktop.root, 'owner/session', ident)
    def stop(*args, **kwargs):
        if outcome == 'timeout': raise H.HostControlError(503, 'Graceful shutdown timed out. No force was used.')
        desktop.state['main.py'] = 'unknown' if outcome == 'unknown' else 'running'
        return {'stopped': True}
    monkeypatch.setattr(L, 'stop_owned_backend', stop)
    assert not lifecycle.run(desktop.root, ident)
    assert not desktop.launched
    assert lifecycle.receipt(desktop.root, 'owner/session', ident)['status'] == 'failed'


def test_post_response_authorization_failure_cancels_only_undispatched_intent(desktop):
    _, _, ident = prepare(desktop)
    assert lifecycle.fail_dispatch(desktop.root, 'owner/session', ident, 'The session ended.')
    lifecycle.dispatch(desktop.root, 'owner/session', ident)
    assert not desktop.spawned
    assert lifecycle.receipt(desktop.root, 'owner/session', ident)['status'] == 'failed'


def test_uncertain_spawn_cannot_be_replayed(desktop, monkeypatch):
    _, _, ident = prepare(desktop)
    calls = []
    def uncertain(*args, **kwargs):
        calls.append(args)
        raise OSError('Synthetic identity capture failure after process creation')
    monkeypatch.setattr(L, 'spawn_fixed', uncertain)
    result = lifecycle.dispatch(desktop.root, 'owner/session', ident)
    assert result['status'] == 'uncertain'
    lifecycle.dispatch(desktop.root, 'owner/session', ident)
    assert len(calls) == 1 and lifecycle.run(desktop.root, ident) is False
    assert not desktop.stopped


@pytest.mark.parametrize('tamper', ['action', 'child', 'signature', 'helper'])
def test_worker_requires_signed_intent_and_its_own_recorded_generation(desktop, tamper):
    _, _, ident = prepare(desktop)
    lifecycle.dispatch(desktop.root, 'owner/session', ident)
    value = lifecycle._read(desktop.root)
    row = value['operations'][0]
    if tamper == 'action': row['action'] = 'quit'
    elif tamper == 'child': row['child']['pid'] += 1
    elif tamper == 'signature': row['proof'] = '0' * 64
    else: row['helper']['pid'] += 1
    lifecycle._write(desktop.root, value)
    if tamper == 'helper': assert lifecycle.run(desktop.root, ident) is False
    else:
        with pytest.raises(H.HostControlError): lifecycle.run(desktop.root, ident)
    assert not desktop.stopped and not desktop.launched


def test_settings_changed_after_dispatch_fail_without_shutdown(desktop):
    _, _, ident = prepare(desktop)
    lifecycle.dispatch(desktop.root, 'owner/session', ident)
    desktop.settings['next_settings']['port'] += 1
    assert lifecycle.run(desktop.root, ident) is False
    assert not desktop.stopped and not desktop.launched
    assert lifecycle.receipt(desktop.root, 'owner/session', ident)['status'] == 'failed'


def test_receipts_and_previews_are_bounded_and_corruption_is_preserved(desktop):
    for _ in range(lifecycle.MAX_PREVIEWS): lifecycle.preview(desktop.root, 'owner/session', 'quit')
    with pytest.raises(H.HostControlError) as full: lifecycle.preview(desktop.root, 'owner/session', 'quit')
    assert full.value.status == 429
    desktop.clock[0] += 61
    lifecycle.preview(desktop.root, 'owner/session', 'quit')
    assert len(lifecycle._read(desktop.root)['previews']) == 1
    path = H.path_for(desktop.root, 'lifecycle.json')
    path.write_text('{corrupt')
    with pytest.raises(H.HostControlError): lifecycle.preview(desktop.root, 'owner/session', 'quit')
    assert path.read_text() == '{corrupt' and not desktop.spawned


def test_cross_process_state_lease_prevents_confirmation(desktop):
    preview = lifecycle.preview(desktop.root, 'owner/session', 'restart')
    with H.FileLock(H.path_for(desktop.root, 'lifecycle-state.lock')):
        with pytest.raises(H.HostControlError):
            lifecycle.confirm(desktop.root, 'owner/session', preview['preview_id'], 'a' * 32)
    assert not desktop.spawned and not desktop.stopped


@pytest.mark.parametrize('arguments', [(), ('--request', 'not-hex'), ('--request', 'a'*32, '--root', 'elsewhere'), ('--command', 'anything')])
def test_fixed_helper_rejects_paths_commands_and_unbounded_arguments(arguments):
    assert not L._fixed_arguments('host_lifecycle.py', arguments)


def test_generation_probe_access_denied_is_unknown_and_pid_reuse_proves_old_exit(tmp_path, monkeypatch):
    import psutil
    child = {'pid': 123456, 'created_at': 12.5, 'script': 'main.py'}
    monkeypatch.setattr(L, 'matches_process', lambda *_: True)
    def denied(_): raise psutil.AccessDenied(123456)
    monkeypatch.setattr(psutil, 'Process', denied)
    assert L.process_generation_state(tmp_path, child) == 'unknown'
    monkeypatch.setattr(psutil, 'Process', lambda _: SimpleNamespace(create_time=lambda: 13.5))
    assert L.process_generation_state(tmp_path, child) == 'exited'
    monkeypatch.setattr(psutil, 'Process', lambda _: SimpleNamespace(create_time=lambda: 12.5))
    assert L.process_generation_state(tmp_path, child) == 'running'


@pytest.mark.parametrize('helper_state', ['unrecorded', 'exited', 'unknown'])
def test_explicit_new_desktop_generation_reconciles_only_proven_exited_operations(desktop, monkeypatch, helper_state):
    _, _, ident = prepare(desktop)
    if helper_state != 'unrecorded': lifecycle.dispatch(desktop.root, 'owner/session', ident)
    desktop.child['created_at'] += 100
    def state(_root, row):
        if row['script'] == 'host_lifecycle.py': return helper_state
        return 'running' if row['created_at'] == desktop.child['created_at'] else 'exited'
    monkeypatch.setattr(L, 'process_generation_state', state)
    result = lifecycle.capabilities(desktop.root)
    assert result['available'] is (helper_state != 'unknown')
    status = lifecycle.receipt(desktop.root, 'owner/session', ident)['status']
    assert status == ('accepted' if helper_state == 'unknown' else 'failed')
    assert not desktop.stopped and not desktop.launched


def test_real_route_service_preview_confirm_dispatch_receipt_contract(desktop, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    import tli_state as S
    from ai.model_downloads import downloads
    from routers import host_control_routes as routes
    from routers.system_routes import require_session
    monkeypatch.setattr(S, 'BASE_DIR', str(desktop.root))
    monkeypatch.setattr(S, 'SERVER_BIND_PORT', 8000)
    monkeypatch.setattr(S, 'TLS_ENABLED', False)
    monkeypatch.setattr(S, 'load_pin_config', lambda: {'enabled': False})
    monkeypatch.setattr(S, 'validate_session_token', lambda token: False)
    monkeypatch.setattr(downloads, 'status', lambda: {'in_progress': False})
    app = FastAPI(); app.include_router(routes.router)
    app.dependency_overrides[require_session] = lambda: 'local'
    client = TestClient(app, base_url='http://localhost:8000', client=('127.0.0.1', 55443))
    prefix = '/api/host-control/v1/lifecycle'
    capability = client.get(prefix).json()
    assert capability['schema_version'] == 1 and capability['capabilities'] == {'restart': True, 'quit': True}
    preview = client.post(prefix + '/preview', json={'action': 'restart'}, headers={'Origin': 'http://localhost:8000'})
    assert preview.status_code == 200
    body = preview.json()
    assert body['instance_id'] == capability['instance_id']
    assert body['installation_id'] == desktop.identity['installation_id']
    assert body['expires_at'] > desktop.clock[0]
    assert not desktop.spawned and not desktop.stopped
    request = {'preview_id': body['preview_id'], 'request_id': 'e' * 32}
    confirmed = client.post(prefix + '/confirm', json=request, headers={'Origin': 'http://localhost:8000'})
    assert confirmed.status_code == 202
    assert confirmed.json()['accepted'] and confirmed.json()['status'] == 'accepted'
    assert len(desktop.spawned) == 1 and not desktop.stopped and not desktop.launched
    receipt = client.get(prefix + '/receipt/' + request['request_id'])
    assert receipt.status_code == 200 and receipt.json()['request_id'] == request['request_id']
    again = client.post(prefix + '/confirm', json=request, headers={'Origin': 'http://localhost:8000'})
    assert again.json()['duplicate'] and len(desktop.spawned) == 1
