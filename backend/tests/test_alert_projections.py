"""Alert failures stay unknown in projections; all host observations are mocked."""
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest

import ambient
import tli_state as S
from intelligence import storage_monitor
from routers import chat_routes, dashboard_presence as dp


@pytest.fixture
def surface(tmp_path, monkeypatch):
    monkeypatch.setattr(S, 'PIN_CONFIG_FILE', tmp_path / 'pin.json')
    monkeypatch.setattr(S, '_active_sessions', {})
    monkeypatch.setattr(dp, '_refresh_narrator', lambda: None)
    observed = []
    for name in ('_read_state', '_node_snapshot', '_ai_snapshot', '_vault_snapshot',
                 '_disk_snapshot', '_smart_home_snapshot', '_mesh_snapshot'):
        def fake(*args, _name=name, **kwargs):
            observed.append(_name)
            return {}
        monkeypatch.setattr(dp, name, fake)
    monkeypatch.setattr(dp, 'get_top_action', lambda: None)
    monkeypatch.setattr(dp, '_get_narrator', lambda: {})
    monkeypatch.setattr(dp, '_recent_action_receipts', lambda: [])
    monkeypatch.setattr(dp, '_health_snapshot', lambda snapshot: {'score': 100})
    monkeypatch.setattr(dp, '_build_suggestions', lambda snapshot: [])
    app = FastAPI()
    app.include_router(dp.router)
    with TestClient(app, base_url='http://localhost:8000', client=('127.0.0.1', 1000),
                    headers={'Origin': 'http://localhost:8000'}, raise_server_exceptions=False) as client:
        yield client, observed


@pytest.mark.parametrize('failure', [HTTPException(503, 'Saved alerts unavailable'),
                                   OSError('PRIVATE path or storage error')])
def test_unavailable_alerts_block_healthy_dashboard_before_host_probes(surface, monkeypatch, failure):
    client, observed = surface
    def load(*, check):
        check()
        raise failure
    monkeypatch.setattr(S, 'load_alerts', load)
    response = client.get('/dashboard/command-center')
    assert response.status_code == 503
    assert response.headers['cache-control'] == 'no-store'
    assert 'PRIVATE' not in response.text and 'score' not in response.text
    assert observed == []


@pytest.mark.parametrize('fail_read', [False, True])
@pytest.mark.parametrize('revoke', ['cookie', 'epoch', 'security'])
def test_original_access_rechecked_on_alert_result_and_error(surface, monkeypatch, fail_read, revoke):
    client, observed = surface
    if revoke == 'cookie':
        S.save_pin_config('a' * 64, 'b' * 64)
        token = S.create_session_token('owner')
        client.headers['Cookie'] = 'tli_session=' + token
    def load(*, check):
        check()
        if revoke == 'cookie':
            S.revoke_session_token(token)
        elif revoke == 'epoch':
            S.revoke_all_sessions()
        else:
            S.PIN_CONFIG_FILE.write_bytes(b'{PRIVATE damaged security')
        if fail_read:
            raise OSError('PRIVATE storage failure')
        return [{'id': 'a', 'message': 'PRIVATE alert'}]
    monkeypatch.setattr(S, 'load_alerts', load)
    response = client.get('/dashboard/command-center')
    assert response.status_code == (503 if revoke == 'security' else 401)
    assert response.headers['cache-control'] == 'no-store'
    assert 'PRIVATE' not in response.text and observed == []


def test_valid_empty_is_distinct_from_unavailable_and_keeps_aggregate(surface, monkeypatch):
    client, observed = surface
    checks = []
    def load(*, check):
        check()
        checks.append(check)
        return []
    monkeypatch.setattr(S, 'load_alerts', load)
    response = client.get('/dashboard/command-center')
    assert response.status_code == 200
    assert response.json()['alerts'] == response.json()['activeAlerts'] == []
    assert response.json()['health']['score'] == 100
    assert len(checks) == 1 and len(observed) == 7


def test_dashboard_active_alert_limit_preserves_store_order_and_rows(monkeypatch):
    rows = [{'id': str(i), 'message': str(i), 'dismissed': i % 3 == 0,
             'compatible': {'keep': i}} for i in range(40)]
    check = Mock()
    def load(*, check):
        check()
        return rows
    monkeypatch.setattr(S, 'load_alerts', load)
    assert dp._active_alerts(5, check=check) == [row for row in rows if not row['dismissed']][-5:]
    assert len(rows) == 40 and check.call_count == 2


@pytest.mark.parametrize('failure', [HTTPException(503, 'PRIVATE store error'), OSError('PRIVATE read')])
def test_optional_disk_alert_failure_does_not_disable_other_checks(monkeypatch, failure):
    calls, logs = [], []
    def disk():
        calls.append('disk')
        raise failure
    monkeypatch.setattr(ambient, '_check_disk', disk)
    monkeypatch.setattr(storage_monitor, 'tick', lambda: calls.append('storage'))
    monkeypatch.setattr(ambient, '_check_shelly_devices', lambda: calls.append('devices'))
    monkeypatch.setattr(ambient, '_check_mesh_nodes', lambda: calls.append('mesh'))
    monkeypatch.setattr(S, 'log_debug', lambda *args, **kwargs: logs.append((args, kwargs)))
    ambient.run_all_checks()
    assert calls == ['disk', 'storage', 'devices', 'mesh']
    assert len(logs) == 1 and 'PRIVATE' not in str(logs)


@pytest.fixture
def home(monkeypatch):
    monkeypatch.setattr(ambient, '_psutil', SimpleNamespace(disk_partitions=lambda **kwargs: []))
    monkeypatch.setattr(ambient.shutil, 'disk_usage', lambda path: SimpleNamespace(total=100, used=20, free=80))
    monkeypatch.setattr(S, 'load_shelly_registry', lambda: [])
    monkeypatch.setattr(S, 'load_mesh_directory', lambda: {})
    monkeypatch.setattr(S, 'load_node_config', lambda: SimpleNamespace(node_id='fixture', role='host'))


@pytest.mark.parametrize('rows', [[], [{'message': 'Example', 'dismissed': False}],
                                [{'future': True}], [{'dismissed': True, 'message': 'Old'}]])
def test_home_alert_snapshot_preserves_valid_legacy_projection(home, monkeypatch, rows):
    monkeypatch.setattr(S, 'load_alerts', lambda: rows)
    snapshot = ambient.get_home_snapshot()
    assert snapshot['alerts_available'] is True
    active = [row for row in rows if not row.get('dismissed')]
    assert snapshot['alert_count'] == len(active)
    assert snapshot['alert_messages'] == [row.get('message') or 'System alert' for row in active]


def test_home_alert_failure_is_unknown_in_context_without_private_error(home, monkeypatch):
    def fail():
        raise HTTPException(503, 'PRIVATE saved path')
    monkeypatch.setattr(S, 'load_alerts', fail)
    snapshot = ambient.get_home_snapshot()
    assert snapshot['alerts_available'] is False
    assert snapshot['alert_count'] is None and snapshot['alert_messages'] == []
    prompt = chat_routes.build_system_prompt('owner', None, None, False, home_snapshot=snapshot)
    assert 'Saved alerts are unavailable; current alert status is unknown.' in prompt
    assert 'PRIVATE' not in prompt and 'Active alerts (0)' not in prompt


def test_unknown_alert_context_cannot_include_stale_messages():
    prompt = chat_routes.build_system_prompt('owner', None, None, False,
        home_snapshot={'alerts_available': False, 'alert_count': 3, 'alert_messages': ['PRIVATE stale']})
    assert 'current alert status is unknown' in prompt and 'PRIVATE stale' not in prompt
