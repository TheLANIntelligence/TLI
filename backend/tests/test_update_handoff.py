"""Explicit update handoff in synthetic installations; never stop the real host."""
import hashlib
import io
import json
import subprocess
import os
import sys
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import auto_update as U
import host_control as H
import host_lifecycle as C
import private_client_authority as A
import tli_state as S
import update_handoff as W
import update_install as I
from routers import update_routes as R
from routers.system_routes import require_session
from .test_host_lifecycle import desktop

ORIGIN = 'http://localhost:8000'
IDENT = 'd' * 32


@pytest.fixture
def update(desktop, monkeypatch):
    root = desktop.root
    files = {
        'backend/main.py': b'# new main', 'backend/tli_state.py': b'TLI_VERSION="2.0.0"',
        'backend/requirements.txt': b'psutil>=5.9', 'backend/update_install.py': b'# new installer',
        'backend/host_launcher.py': b'# new launcher', 'backend/host_lifecycle.py': b'# new lifecycle',
        'backend/update_handoff.py': b'# new handoff', 'frontend/index.html': b'<html>new</html>',
        'TLI_Update.bat': b'@echo off', 'TLI_Update.ps1': b'# guided',
        'TLI_Update.command': b'#!/bin/bash', 'TLI_Update.sh': b'#!/bin/bash',
        'TLI_Bootstrap.ps1': b'param([switch]$SetupOnly)', 'TLI_Start.sh': b'#!/bin/bash',
    }
    for name, content in {'backend/main.py': b'# old main', 'backend/tli_state.py': b'TLI_VERSION="1.0.0"',
                          'frontend/index.html': b'old', 'data/private-canary.json': b'PRIVATE',
                          'models/private-model.gguf': b'MODEL', 'backend/.venv/private-canary': b'ENV'}.items():
        path = root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(content)
    source = root / 'data/updates' / ('job-' + 'e' * 32) / 'package'
    for name, content in files.items():
        path = source / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(content)
    manifest = {'schema_version': 1, 'version': '2.0.0', 'platform': 'all',
                'files': [{'path': name, 'size': len(value), 'sha256': hashlib.sha256(value).hexdigest(), 'mode': 0o644}
                          for name, value in files.items()]}
    raw = json.dumps(manifest).encode()
    (source / I.MANIFEST_NAME).write_bytes(raw)
    package = {'version': '2.0.0', 'folder': source.parent.name, 'manifest_sha256': hashlib.sha256(raw).hexdigest()}
    (root / 'data/updates/prepared.json').write_text(json.dumps(package))
    monkeypatch.setattr(S, 'BASE_DIR', str(root)); monkeypatch.setattr(S, 'DATA_DIR', str(root / 'data'))
    monkeypatch.setattr(S, 'TLI_VERSION', '1.0.0'); monkeypatch.setattr(S, 'SERVER_BIND_PORT', 8000)
    monkeypatch.setattr(S, 'TLS_ENABLED', False); monkeypatch.setattr(S, 'load_pin_config', lambda: {'enabled': False})
    monkeypatch.setattr(S, '_session_revocation_epoch', object())
    monkeypatch.setattr(U, '_state', U.UpdateState.READY); monkeypatch.setattr(U, '_info', {'version': '2.0.0', 'can_prepare': True})
    monkeypatch.setattr(U, '_ready_path', str(source)); monkeypatch.setattr(U, '_SETTINGS_FILE', root / 'data/update_settings.json')
    monkeypatch.setattr(W.sys, 'platform', 'win32')
    monkeypatch.setattr(W, 'check_helper_blockers', lambda root, *, check: check())
    from ai.model_downloads import downloads
    monkeypatch.setattr(downloads, 'status', lambda: {'in_progress': False})
    checks, setup = [], []
    def stopped(target):
        assert desktop.state['main.py'] == 'exited'
        checks.append(target)
    monkeypatch.setattr(I, 'ensure_stopped', stopped)
    monkeypatch.setattr(W, 'prepare_dependencies', lambda *args, **kwargs: setup.append(args))
    app = FastAPI(); app.include_router(R.router)
    client = TestClient(app, base_url=ORIGIN, client=('127.0.0.1', 50001), headers={'Origin': ORIGIN})
    return SimpleNamespace(desktop=desktop, root=root, source=source, package=package,
                           client=client, app=app, checks=checks, setup=setup)


def preview(update):
    response = update.client.post('/update/install/preview', json={})
    assert response.status_code == 200, response.text
    return response.json()


def confirm(update, review=None):
    review = review or preview(update)
    return update.client.post('/update/install/confirm', json={'preview_id': review['preview_id'], 'request_id': IDENT})


def test_review_confirm_worker_install_setup_restart_and_receipt_preserve_private_files(update):
    review = preview(update)
    assert review['version'] == '2.0.0' and review['current_version'] == '1.0.0'
    assert review['installation_id'] == update.desktop.identity['installation_id']
    assert review['preserves'] == ['data', 'models', 'Python environment']
    assert any('Internet' in text for text in review['consequences'])
    assert not update.desktop.spawned and not update.checks
    response = confirm(update, review)
    assert response.status_code == 202 and response.json()['status'] == 'accepted'
    assert response.headers['cache-control'] == 'no-store'
    assert len(update.desktop.spawned) == 1 and not update.desktop.stopped
    duplicate = confirm(update, review)
    assert duplicate.json()['duplicate'] and len(update.desktop.spawned) == 1
    status = update.client.get('/update/status').json()
    assert status['install_operation']['installation_id'] == review['installation_id']
    assert C.run(update.root, IDENT)
    assert update.checks and len(update.setup) == 1 and len(update.desktop.launched) == 1
    receipt = update.client.get('/update/install/receipt/' + IDENT).json()
    assert receipt['status'] == 'completed' and receipt['installed'] and receipt['backend_exit_confirmed']
    assert receipt['schema_version'] == 1 and receipt['instance_id'] == review['instance_id']
    assert (update.root / 'backend/main.py').read_bytes() == b'# new main'
    for name, expected in [('data/private-canary.json', b'PRIVATE'), ('models/private-model.gguf', b'MODEL'), ('backend/.venv/private-canary', b'ENV')]:
        assert (update.root / name).read_bytes() == expected
    assert list((update.root / 'data/updates/backups').glob('*/journal.json'))
    assert not C.run(update.root, IDENT) and len(update.desktop.launched) == 1


@pytest.mark.parametrize('boundary', ['preview', 'confirm', 'worker'])
def test_package_tampering_never_stops_or_installs(update, boundary):
    review = preview(update) if boundary != 'preview' else None
    if boundary == 'worker': assert confirm(update, review).status_code == 202
    (update.source / 'backend/main.py').write_bytes(b'tampered')
    if boundary == 'worker':
        assert not C.run(update.root, IDENT)
        assert update.client.get('/update/install/receipt/' + IDENT).json()['status'] == 'failed'
    else:
        response = update.client.post('/update/install/preview', json={}) if boundary == 'preview' else confirm(update, review)
        assert response.status_code == 409
    assert not update.desktop.stopped and not update.checks


def test_signed_package_identity_cannot_be_changed_after_dispatch(update):
    assert confirm(update).status_code == 202
    store = C._read(update.root); store['operations'][0]['package']['manifest_sha256'] = '0' * 64
    C._write(update.root, store)
    with pytest.raises(H.HostControlError): C.run(update.root, IDENT)
    assert not update.desktop.stopped and not update.checks


@pytest.mark.parametrize('boundary', ['hash', 'encode'])
def test_access_loss_during_review_withholds_result_and_prevents_dispatch(update, monkeypatch, boundary):
    if boundary == 'hash':
        original = I._hash
        def revoke(*args, **kwargs):
            result = original(*args, **kwargs)
            S._session_revocation_epoch = object()
            return result
        monkeypatch.setattr(I, '_hash', revoke)
    else:
        original = A.JSONResponse
        def revoke(*args, **kwargs):
            result = original(*args, **kwargs)
            S._session_revocation_epoch = object()
            return result
        monkeypatch.setattr(A, 'JSONResponse', revoke)
    response = update.client.post('/update/install/preview', json={})
    assert response.status_code == 401 and response.headers['cache-control'] == 'no-store'
    assert 'preview_id' not in response.text and not update.desktop.spawned


def test_access_loss_after_confirmation_encoding_cancels_intent(update, monkeypatch):
    review = preview(update)
    original = A.JSONResponse
    def revoke(*args, **kwargs):
        result = original(*args, **kwargs); S._session_revocation_epoch = object(); return result
    monkeypatch.setattr(A, 'JSONResponse', revoke)
    response = confirm(update, review)
    assert response.status_code == 401 and not update.desktop.spawned
    assert C._read(update.root)['operations'][0]['status'] == 'failed'


def test_duplicate_confirmation_cannot_dispatch_previously_undispatched_intent(update, monkeypatch):
    review = preview(update)
    calls = []
    monkeypatch.setattr(R, '_dispatch_install', lambda *args: calls.append('original response only'))
    assert confirm(update, review).status_code == 202
    assert C._read(update.root)['operations'][0].get('dispatch_at') is None
    response = confirm(update, review)
    assert response.status_code == 202 and response.json()['duplicate']
    assert calls == ['original response only'] and not update.desktop.spawned


def test_cross_origin_restart_expires_old_cookie_on_actual_json_response(update):
    update.desktop.settings['next_settings'].update(port=8443, https=True)
    response = confirm(update)
    assert response.status_code == 202 and response.json()['next_url'] == 'https://127.0.0.1:8443'
    assert 'tli_session=""' in response.headers['set-cookie'] and 'Max-Age=0' in response.headers['set-cookie']


@pytest.mark.parametrize('failure', ['locked', 'unavailable'])
def test_status_never_reads_private_update_state_after_denial(update, monkeypatch, failure):
    if failure == 'locked': monkeypatch.setattr(S, 'load_pin_config', lambda: {'enabled': True})
    else: monkeypatch.setattr(S, 'load_pin_config', lambda: (_ for _ in ()).throw(OSError('secret')))
    monkeypatch.setattr(U, 'get_status', lambda: pytest.fail('Private update state read after denial'))
    response = update.client.get('/update/status')
    assert response.status_code == (401 if failure == 'locked' else 503)
    assert 'ready_path' not in response.text and 'secret' not in response.text


def test_status_loss_during_read_withholds_private_path(update, monkeypatch):
    def revoke():
        S._session_revocation_epoch = object()
        return {'ready_path': 'PRIVATE CANARY'}
    monkeypatch.setattr(U, 'get_status', revoke)
    response = update.client.get('/update/status')
    assert response.status_code == 401 and 'PRIVATE CANARY' not in response.text


@pytest.mark.parametrize('kind', ['locked', 'native', 'proxy', 'remote', 'foreign-origin'])
def test_actual_local_browser_authority_required_even_with_dependency_override(update, monkeypatch, kind):
    update.app.dependency_overrides[require_session] = lambda: 'local'
    headers = {}
    client = update.client
    if kind == 'locked': monkeypatch.setattr(S, 'load_pin_config', lambda: {'enabled': True})
    elif kind == 'native': headers['Authorization'] = 'Bearer tlic_fake'
    elif kind == 'proxy': headers['X-Forwarded-For'] = '127.0.0.1'
    elif kind == 'foreign-origin': headers['Origin'] = 'https://evil.example'
    else: client = TestClient(update.app, base_url=ORIGIN, client=('192.168.1.5', 4444), headers={'Origin': ORIGIN})
    assert client.post('/update/install/preview', json={}, headers=headers).status_code in {401, 403}
    assert not update.desktop.spawned and not C._read(update.root)['previews']


def test_unavailable_security_during_hash_is_sticky_denial(update, monkeypatch):
    original = I._hash
    def unavailable(*args, **kwargs):
        result = original(*args, **kwargs)
        monkeypatch.setattr(S, 'load_pin_config', lambda: (_ for _ in ()).throw(OSError('private canary')))
        return result
    monkeypatch.setattr(I, '_hash', unavailable)
    response = update.client.post('/update/install/preview', json={})
    assert response.status_code == 503 and 'private canary' not in response.text
    assert not update.desktop.spawned


@pytest.mark.parametrize('failure', ['shutdown', 'install', 'setup', 'setup-uncertain', 'restart'])
def test_failures_do_not_restart_early_or_replay(update, monkeypatch, failure):
    assert confirm(update).status_code == 202
    def fail(*args, **kwargs): raise H.HostControlError(503, 'Synthetic failure')
    if failure == 'shutdown': monkeypatch.setattr(C.L, 'stop_owned_backend', fail)
    elif failure == 'install': monkeypatch.setattr(I, 'install', fail)
    elif failure == 'setup': monkeypatch.setattr(W, 'prepare_dependencies', fail)
    elif failure == 'restart': monkeypatch.setattr(C.L, 'launch', fail)
    else: monkeypatch.setattr(W, 'prepare_dependencies', lambda *args, **kwargs: (_ for _ in ()).throw(W.SetupUncertain(503, 'Still running')))
    assert not C.run(update.root, IDENT)
    receipt = update.client.get('/update/install/receipt/' + IDENT).json()
    assert receipt['status'] == ('uncertain' if failure == 'setup-uncertain' else 'failed')
    assert receipt['installed'] is (failure in {'setup', 'setup-uncertain', 'restart'})
    assert not update.desktop.launched
    assert not C.run(update.root, IDENT)


def test_install_rechecks_reviewed_manifest_under_install_lock(update, monkeypatch):
    update.desktop.state['main.py'] = 'exited'
    original = I._validate_source
    def change(*args, **kwargs):
        value = original(*args, **kwargs)
        path = update.source / I.MANIFEST_NAME
        path.write_bytes(path.read_bytes() + b' ')
        return value
    monkeypatch.setattr(I, '_validate_source', change)
    with pytest.raises(I.UpdateError, match='reviewed update manifest changed'):
        I.install(update.source, update.root, expected_manifest_sha256=update.package['manifest_sha256'])
    assert (update.root / 'backend/main.py').read_bytes() == b'# old main'


def test_setup_uses_fixed_hidden_command_scrubs_pip_credentials_and_does_not_kill(tmp_path, monkeypatch):
    root = tmp_path / 'desktop'; root.mkdir()
    identity = H.installation(root, create=True)
    calls = []
    monkeypatch.setattr(W.sys, 'platform', 'win32')
    monkeypatch.setenv('PIP_INDEX_URL', 'https://secret:password@example.invalid/simple')
    monkeypatch.setenv('HTTPS_PROXY', 'https://secret:password@example.invalid')
    class Process:
        stdout = io.BytesIO(b'safe setup output')
        def wait(self, timeout=None):
            if timeout is not None: raise subprocess.TimeoutExpired('fixed setup', timeout)
            return 0
        def kill(self): pytest.fail('Setup timeout must never force-kill')
        def terminate(self): pytest.fail('Setup timeout must never force-terminate')
    monkeypatch.setattr(W.subprocess, 'Popen', lambda command, **kwargs: calls.append((command, kwargs)) or Process())
    with pytest.raises(W.SetupUncertain):
        W.prepare_dependencies(root, {'host': '127.0.0.1', 'port': 8000, 'https': False}, timeout=1)
    command, options = calls[0]
    assert command[-2:] == [str(root / 'TLI_Bootstrap.ps1'), '-SetupOnly']
    assert options['shell'] is False
    if os.name == 'nt': assert options['creationflags'] & subprocess.CREATE_NO_WINDOW
    assert 'PIP_INDEX_URL' not in options['env'] and 'HTTPS_PROXY' not in options['env']
    assert options['env']['PIP_NO_INPUT'] == '1' and identity['installation_id'] == options['env']['TLI_MANAGED_CHILD']


def test_real_setup_child_timeout_retains_drain_until_exit_and_never_restarts(tmp_path, monkeypatch):
    root = tmp_path / 'desktop'; root.mkdir(); H.installation(root, create=True)
    monkeypatch.setattr(W.sys, 'platform', 'win32')
    original = subprocess.Popen
    child = []
    def spawn(command, **options):
        process = original([sys.executable, '-c', "import time; print('begin',flush=True); time.sleep(.4); print('finished',flush=True)"], **options)
        child.append(process)
        return process
    monkeypatch.setattr(W.subprocess, 'Popen', spawn)
    events, recorded = [], []
    with pytest.raises(W.SetupUncertain):
        W.prepare_dependencies(root, {'host': '127.0.0.1', 'port': 8000, 'https': False}, timeout=.05,
            record_child=lambda generation: recorded.append(generation),
            on_timeout=lambda: events.append(('timeout', child[0].poll())),
            on_exit=lambda: events.append(('exited', child[0].poll())))
    assert events == [('timeout', None), ('exited', 0)]
    assert W.setup_generation_state(recorded[0]) == 'exited'
    assert b'finished' in H.path_for(root, 'update-setup.log').read_bytes()


@pytest.mark.parametrize('setup_state', ['running', 'unknown', 'exited'])
def test_reconciliation_requires_setup_exit_as_well_as_host_and_helper_exit(update, monkeypatch, setup_state):
    assert confirm(update).status_code == 202
    value = C._read(update.root)
    value['operations'][0].update(status='uncertain', setup_pending=True, setup={'pid': 6789, 'created_at': 10.0})
    C._write(update.root, value)
    update.desktop.child['created_at'] += 100
    monkeypatch.setattr(C.L, 'process_generation_state', lambda root, row: 'running' if row == update.desktop.child else 'exited')
    monkeypatch.setattr(W, 'setup_generation_state', lambda child: setup_state)
    result = C.capabilities(update.root)
    assert result['available'] is (setup_state == 'exited')
    assert not update.desktop.stopped


@pytest.mark.parametrize('helper', ['host_control_server.py', 'desktop_launcher.py', 'TLI_Bootstrap.ps1'])
def test_known_conflicting_helpers_are_detected_before_shutdown(tmp_path, monkeypatch, helper):
    import psutil
    root = tmp_path / 'installation'; root.mkdir()
    process = SimpleNamespace(info={'pid': 12345, 'name': 'python.exe'},
        as_dict=lambda **kwargs: {'exe': 'python.exe', 'cmdline': ['python.exe', str(root / 'backend' / helper)], 'cwd': str(root)})
    monkeypatch.setattr(psutil, 'process_iter', lambda *args, **kwargs: [process])
    with pytest.raises(H.HostControlError, match='Close the separate'):
        W.check_helper_blockers(root)


def test_helper_preflight_rechecks_authority_after_process_inspection(tmp_path, monkeypatch):
    import psutil
    allowed = [True]
    def inspect(**kwargs):
        allowed[0] = False
        return {'exe': 'python.exe', 'cmdline': [], 'cwd': str(tmp_path)}
    process = SimpleNamespace(info={'pid': 12345, 'name': 'python.exe'}, as_dict=inspect)
    monkeypatch.setattr(psutil, 'process_iter', lambda *args, **kwargs: [process])
    def check():
        if not allowed[0]: raise H.HostControlError(401, 'Revoked')
    with pytest.raises(H.HostControlError, match='Revoked'):
        W.check_helper_blockers(tmp_path, check=check)
