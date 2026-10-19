"""Hardware HTTP reads use real browser authority and synthetic host probes."""
import ctypes
import sys
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest

import tli_state as S
from routers import system_routes as routes


ENDPOINTS = [('/system/probe', 'system_probe'), ('/system/summary', 'system_summary'),
             ('/api/system/disk', 'system_disk')]
GB = 1024 ** 3


@pytest.fixture
def hardware_host(tmp_path, monkeypatch):
    root = tmp_path / 'data'
    root.mkdir()
    monkeypatch.setattr(S, 'DATA_DIR', str(root))
    monkeypatch.setattr(S, 'PIN_CONFIG_FILE', root / 'tli_pin.json')
    monkeypatch.setattr(S, '_active_sessions', {})
    S.save_pin_config('a' * 64, 'b' * 64)
    token = S.create_session_token('owner')
    blocked = {}
    for name in ('load_node_config', 'save_node_config', 'load_devices', 'save_devices'):
        blocked[name] = Mock(side_effect=AssertionError('Unexpected persistent state access'))
        monkeypatch.setattr(S, name, blocked[name])
    ps = SimpleNamespace(
        cpu_count=Mock(side_effect=lambda logical: 16 if logical else 8),
        virtual_memory=Mock(return_value=SimpleNamespace(total=32 * GB, available=12 * GB)),
        disk_partitions=Mock(return_value=[SimpleNamespace(mountpoint='C:\\', fstype='NTFS'),
                                          SimpleNamespace(mountpoint='D:\\', fstype='NTFS')]),
        disk_usage=Mock(return_value=SimpleNamespace(total=100 * GB, used=40 * GB, free=60 * GB, percent=40)),
    )
    monkeypatch.setattr(routes, 'psutil', ps)
    monkeypatch.setattr(routes.platform, 'system', lambda: 'Windows')
    monkeypatch.setattr(routes.platform, 'processor', lambda: 'PRIVATE synthetic CPU')
    monkeypatch.setattr(routes.platform, 'machine', lambda: 'Synthetic64')
    monkeypatch.setattr(routes.platform, 'release', lambda: 'SyntheticOS')
    monkeypatch.setattr(routes.platform, 'version', lambda: 'SyntheticVersion')
    monkeypatch.setenv('SystemDrive', 'C:')
    nvml = SimpleNamespace(nvmlInit=Mock(), nvmlShutdown=Mock(),
                           nvmlDeviceGetHandleByIndex=Mock(return_value='synthetic-device'),
                           nvmlDeviceGetMemoryInfo=Mock(return_value=SimpleNamespace(total=8 * GB)))
    monkeypatch.setitem(sys.modules, 'pynvml', nvml)
    xml = tmp_path / 'hardware.xml'
    xml.write_text('<DxDiag/>', encoding='utf-8')
    dxdiag = Mock(return_value=str(xml))
    parse = Mock(return_value={'cpu': {'model': 'PRIVATE synthetic CPU'},
                              'gpu': {'model': 'PRIVATE synthetic GPU', 'driver': '1.2.3', 'vram_gb': 8},
                              'display': {'width': 1920, 'height': 1080, 'hz': 60}})
    disks = Mock(return_value=[{'Model': 'PRIVATE synthetic disk', 'InterfaceType': 'SATA',
                               'MediaType': 'SSD', 'Size': 100 * GB}])
    monkeypatch.setattr(routes, '_dxdiag_xml_path', dxdiag)
    monkeypatch.setattr(routes, '_parse_dxdiag', parse)
    monkeypatch.setattr(routes, '_run_pwsh_json', disks)
    monkeypatch.setattr(routes, '_system_summary_cache', {'result': None, 'ts': 0.0})
    # Any accidental escape from the substituted readers fails before an OS probe.
    process = Mock(side_effect=AssertionError('Unmocked hardware subprocess'))
    monkeypatch.setattr(routes.subprocess, 'run', process)
    metrics = Mock(side_effect=AssertionError('Unexpected native display fallback'))
    monkeypatch.setattr(ctypes, 'windll', SimpleNamespace(user32=SimpleNamespace(GetSystemMetrics=metrics)),
                        raising=False)
    app = FastAPI()
    app.include_router(routes.router)
    clients = []

    def browser(mode='pin-local', *, target=app):
        local = mode not in {'pin-https', 'pin-off-lan', 'remote-http'}
        origin = 'http://localhost:8000' if local else (
            'http' if mode == 'remote-http' else 'https') + '://192.0.2.5:8443'
        if mode in {'open-local', 'pin-off-lan', 'pin-off-stale'}:
            S.clear_pin_config()
        client = TestClient(target, base_url=origin,
                            client=('127.0.0.1' if local else '192.0.2.8', 1234),
                            headers={'Origin': origin}, raise_server_exceptions=False)
        if mode not in {'anonymous', 'open-local', 'pin-off-lan'}:
            client.headers['Cookie'] = 'tli_session=' + token
        if mode in {'revoked', 'pin-off-stale'}:
            S.revoke_session_token(token)
        if mode == 'expired': S._active_sessions[token]['expiry'] = 0
        if mode == 'foreign-origin': client.headers['Origin'] = 'https://foreign.invalid'
        if mode == 'same-site': client.headers['Sec-Fetch-Site'] = 'same-site'
        if mode == 'proxy': client.headers['Forwarded'] = 'for=127.0.0.1'
        if mode == 'peer': client.headers['X-TLI-Peer-Id'] = 'synthetic-peer'
        if mode == 'bearer': client.headers['Authorization'] = 'Bearer synthetic-companion'
        clients.append(client)
        return client

    yield SimpleNamespace(root=root, token=token, ps=ps, nvml=nvml, xml=xml, dxdiag=dxdiag,
                          parse=parse, disks=disks, process=process, blocked=blocked, browser=browser)
    for client in clients: client.close()
    process.assert_not_called()
    metrics.assert_not_called()
    for operation in blocked.values(): operation.assert_not_called()


def no_observations(f):
    for operation in vars(f.ps).values(): operation.assert_not_called()
    for operation in vars(f.nvml).values(): operation.assert_not_called()
    f.dxdiag.assert_not_called(); f.parse.assert_not_called(); f.disks.assert_not_called()


@pytest.mark.parametrize('path,service', ENDPOINTS)
@pytest.mark.parametrize('mode,status', [('anonymous', 401), ('revoked', 401), ('expired', 401),
    ('pin-off-stale', 401), ('pin-off-lan', 403), ('remote-http', 403), ('foreign-origin', 403),
    ('same-site', 403), ('proxy', 403), ('peer', 403), ('bearer', 403), ('unavailable', 503)])
def test_private_hardware_denied_before_host_observation(hardware_host, mode, status, path, service):
    f = hardware_host
    if mode == 'unavailable':
        S.PIN_CONFIG_FILE.write_bytes(b'{"PRIVATE": damaged')
    response = f.browser(mode).get(path)
    assert response.status_code == status, response.text
    assert response.headers['cache-control'] == 'no-store'
    assert 'PRIVATE' not in response.text
    no_observations(f)


@pytest.mark.parametrize('path,service', ENDPOINTS)
@pytest.mark.parametrize('mode', ['pin-local', 'pin-https', 'open-local'])
def test_browser_receives_existing_hardware_shapes(hardware_host, mode, path, service):
    f = hardware_host
    client = f.browser(mode)
    before = S.PIN_CONFIG_FILE.read_bytes()
    response = client.get(path)
    assert response.status_code == 200, response.text
    assert response.headers['cache-control'] == 'no-store'
    data = response.json()
    if service == 'system_probe':
        assert data == {'cpu_cores': 8, 'cpu_threads': 16, 'ram_total_gb': 32,
                        'ram_available_gb': 12, 'gpu_vram_gb': 8, 'suggested_profile': 'power'}
        f.nvml.nvmlShutdown.assert_called_once()
    elif service == 'system_summary':
        assert data['cpu']['model'] == 'PRIVATE synthetic CPU'
        assert data['gpu']['model'] == 'PRIVATE synthetic GPU'
        assert data['memory'] == {'total_gb': 32}
        assert data['storage']['drives'][0]['model'] == 'PRIVATE synthetic disk'
        assert not f.xml.exists()
        assert callable(f.dxdiag.call_args.kwargs['check'])
        assert callable(f.parse.call_args.kwargs['check'])
        assert callable(f.disks.call_args.kwargs['check'])
    else:
        assert data['ok'] is True and len(data['drives']) == 2
        assert data['system']['mount'] == 'C:\\'
        assert data['total_gb'] == 100 and data['free_gb'] == 60
    assert S.PIN_CONFIG_FILE.read_bytes() == before


def deny(f, change):
    if change == 'revoke': S.revoke_session_token(f.token)
    elif change == 'expiry': S._active_sessions[f.token]['expiry'] = 0
    elif change == 'owner': S._active_sessions[f.token]['user_id'] = 'different-owner'
    elif change == 'epoch': S.revoke_all_sessions()
    elif change == 'mode': S.clear_pin_config()
    else: S.PIN_CONFIG_FILE.write_bytes(b'{"PRIVATE security": damaged')


@pytest.mark.parametrize('path,service', ENDPOINTS)
@pytest.mark.parametrize('change', ['revoke', 'expiry', 'owner', 'epoch', 'mode', 'damage'])
@pytest.mark.parametrize('error', [False, True])
def test_wrapper_rechecks_after_service_success_or_error(hardware_host, monkeypatch, path, service, change, error):
    f = hardware_host
    client = f.browser('open-local' if change == 'epoch' else 'pin-local')
    def observed(*, check=None):
        assert callable(check)
        check()
        deny(f, change)
        if error: raise RuntimeError('PRIVATE hardware failure')
        return {'PRIVATE': 'hardware result'}
    monkeypatch.setattr(routes, service, observed)
    response = client.get(path)
    assert response.status_code == (503 if change == 'damage' else 401), response.text
    assert response.headers['cache-control'] == 'no-store'
    assert 'PRIVATE' not in response.text


STAGES = [('/system/probe', 'cpu'), ('/system/probe', 'memory'), ('/system/probe', 'nvml'),
          ('/system/summary', 'dxdiag'), ('/system/summary', 'xml'), ('/system/summary', 'storage'),
          ('/api/system/disk', 'partitions'), ('/api/system/disk', 'usage')]


@pytest.mark.parametrize('path,stage', STAGES)
@pytest.mark.parametrize('error', [False, True])
def test_revocation_stops_later_probes_and_withholds_partial_data(hardware_host, path, stage, error):
    f = hardware_host
    boundary = {'cpu': f.ps.cpu_count, 'memory': f.ps.virtual_memory,
                'nvml': f.nvml.nvmlDeviceGetMemoryInfo, 'dxdiag': f.dxdiag,
                'xml': f.parse, 'storage': f.disks, 'partitions': f.ps.disk_partitions,
                'usage': f.ps.disk_usage}[stage]
    value = 16 if stage == 'cpu' else boundary.return_value
    def observed(*args, **kwargs):
        S.revoke_session_token(f.token)
        if error: raise OSError('PRIVATE hardware source failed')
        return value
    boundary.side_effect = observed
    response = f.browser().get(path)
    assert response.status_code == 401, response.text
    assert response.headers['cache-control'] == 'no-store'
    assert 'PRIVATE' not in response.text
    if stage == 'cpu': f.ps.virtual_memory.assert_not_called()
    if stage == 'memory': f.nvml.nvmlInit.assert_not_called()
    if stage == 'nvml': f.nvml.nvmlShutdown.assert_called_once()
    if stage == 'dxdiag': f.parse.assert_not_called(); f.disks.assert_not_called()
    if stage == 'xml': f.disks.assert_not_called(); assert not f.xml.exists()
    if stage == 'partitions': f.ps.disk_usage.assert_not_called()
    if stage == 'usage': assert f.ps.disk_usage.call_count == 1
    if path == '/system/summary': assert routes._system_summary_cache['result'] is None


@pytest.mark.parametrize('path,service', ENDPOINTS)
def test_unexpected_service_error_has_no_private_details(hardware_host, monkeypatch, path, service):
    monkeypatch.setattr(routes, service, Mock(side_effect=RuntimeError('PRIVATE filesystem or device error')))
    response = hardware_host.browser().get(path)
    assert response.status_code == 503
    assert response.json() == {'detail': 'Private system information is unavailable.'}
    assert response.headers['cache-control'] == 'no-store'


@pytest.mark.parametrize('checked', [False, True])
def test_summary_cache_requires_checked_provenance(hardware_host, monkeypatch, checked):
    f = hardware_host
    cache = {'result': {'PRIVATE': 'prior summary'}, 'ts': 10**12, 'checked': checked}
    monkeypatch.setattr(routes, '_system_summary_cache', cache)
    response = f.browser().get('/system/summary')
    assert response.status_code == 200, response.text
    assert response.headers['cache-control'] == 'no-store'
    if checked:
        assert response.json() == cache['result']
        no_observations(f)
    else:
        assert response.json()['cpu']['model'] == 'PRIVATE synthetic CPU'
        f.dxdiag.assert_called_once()


def test_cache_hit_still_requires_current_browser(hardware_host, monkeypatch):
    f = hardware_host
    cache = {'result': {'PRIVATE': 'prior summary'}, 'ts': 10**12, 'checked': True}
    monkeypatch.setattr(routes, '_system_summary_cache', cache)
    response = f.browser('revoked').get('/system/summary')
    assert response.status_code == 401 and 'PRIVATE' not in response.text
    assert routes._system_summary_cache is cache
    no_observations(f)


@pytest.mark.parametrize('path,service', ENDPOINTS)
@pytest.mark.parametrize('mode', ['anonymous', 'pin-off-lan', 'bearer', 'pin-https'])
def test_effective_main_routes_enforce_browser_contract(hardware_host, monkeypatch, app, path, service, mode):
    import companion_auth
    f = hardware_host
    if mode == 'bearer': monkeypatch.setattr(companion_auth, 'credential_owner', lambda _: 'owner')
    response = f.browser(mode, target=app).get(path)
    assert response.status_code == (200 if mode == 'pin-https' else 401 if mode == 'anonymous' else 403), response.text
    assert response.headers['cache-control'] == 'no-store'
    if mode != 'pin-https': no_observations(f)


@pytest.mark.parametrize('path,service', ENDPOINTS)
def test_effective_main_invalid_bearer_cannot_fall_back_to_cookie(hardware_host, monkeypatch, app, path, service):
    import companion_auth
    def invalid(_): raise HTTPException(401, 'Credential revoked')
    monkeypatch.setattr(companion_auth, 'credential_owner', invalid)
    response = hardware_host.browser('bearer', target=app).get(path)
    assert response.status_code == 401
    assert response.headers['cache-control'] == 'no-store'
    no_observations(hardware_host)
