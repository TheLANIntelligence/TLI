"""Private alert observations and dismissals retain real browser authority."""
import json
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest

import alert_store as store
import tli_state as S
from routers import system_routes as routes


ALERT_ID = 'alert-0123456789'
CASES = [('get', '/status/alerts', 'load_alerts'),
         ('post', '/status/alerts/' + ALERT_ID + '/dismiss', 'dismiss_alert'),
         ('post', '/status/alerts/dismiss-all', 'dismiss_all_alerts')]


@pytest.fixture
def alerts_host(tmp_path, monkeypatch):
    root = tmp_path / 'data'
    root.mkdir()
    path = root / 'tli_alerts.json'
    rows = [{'id': ALERT_ID, 'kind': 'cpu', 'message': 'PRIVATE processor alert',
             'detail': 'PRIVATE details', 'severity': 'warn', 'created_at': '2026-10-16T00:00:00Z',
             'dismissed': False, 'future': {'retain': [1, True, None]}},
            {'id': 'alert-abcdef0123', 'kind': 'disk', 'message': 'PRIVATE disk alert',
             'dismissed': False},
            {'id': 'alert-9876543210', 'kind': 'old', 'message': 'PRIVATE historical alert',
             'dismissed': True}]
    path.write_text(json.dumps(rows), encoding='utf-8')
    monkeypatch.setattr(S, 'DATA_DIR', str(root))
    monkeypatch.setattr(S, 'ALERTS_FILE', path)
    monkeypatch.setattr(S, 'PIN_CONFIG_FILE', root / 'pin.json')
    monkeypatch.setattr(S, '_active_sessions', {})
    monkeypatch.setattr(store, '_UNCERTAIN', set())
    monkeypatch.setattr(store, '_SEEN', set())
    S.save_pin_config('a' * 64, 'b' * 64)
    token = S.create_session_token('owner')
    app = FastAPI()
    app.include_router(routes.router)
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
        if mode == 'missing-origin': del client.headers['Origin']
        if mode == 'proxy': client.headers['Forwarded'] = 'for=127.0.0.1'
        if mode == 'peer': client.headers['X-TLI-Peer-Id'] = 'synthetic-peer'
        if mode == 'bearer': client.headers['Authorization'] = 'Bearer synthetic-companion'
        clients.append(client)
        return client
    yield SimpleNamespace(root=root, path=path, rows=rows, token=token, browser=browser)
    for client in clients: client.close()


def request(client, case):
    return getattr(client, case[0])(case[1])


def private_error(response, status):
    assert response.status_code == status, response.text
    assert response.headers['cache-control'] == 'no-store'
    assert 'PRIVATE' not in response.text


def revoke(f, change):
    if change == 'cookie': S.revoke_session_token(f.token)
    elif change == 'owner': S._active_sessions[f.token]['user_id'] = 'different-owner'
    elif change == 'epoch': S.revoke_all_sessions()
    else: S.PIN_CONFIG_FILE.write_bytes(b'{"PRIVATE security":broken')


@pytest.mark.parametrize('case', CASES)
@pytest.mark.parametrize('mode,status', [('anonymous', 401), ('revoked', 401), ('expired', 401),
    ('pin-off-stale', 401), ('pin-off-lan', 403), ('remote-http', 403), ('foreign-origin', 403),
    ('same-site', 403), ('proxy', 403), ('peer', 403), ('bearer', 403), ('unavailable', 503)])
def test_alert_routes_reject_before_private_store_work(alerts_host, monkeypatch, case, mode, status):
    f = alerts_host
    before = f.path.read_bytes()
    blocked = Mock(side_effect=AssertionError('Denied request reached alert service'))
    monkeypatch.setattr(S, case[2], blocked)
    if mode == 'unavailable': S.PIN_CONFIG_FILE.write_bytes(b'{"PRIVATE security":broken')
    private_error(request(f.browser(mode), case), status)
    blocked.assert_not_called()
    assert f.path.read_bytes() == before


@pytest.mark.parametrize('case', CASES[1:])
def test_dismissals_require_same_origin_even_with_live_cookie(alerts_host, case):
    before = alerts_host.path.read_bytes()
    private_error(request(alerts_host.browser('missing-origin'), case), 403)
    assert alerts_host.path.read_bytes() == before


@pytest.mark.parametrize('case', CASES)
@pytest.mark.parametrize('mode', ['pin-local', 'pin-https', 'open-local'])
def test_success_contract_and_preserved_private_alert_fields(alerts_host, case, mode):
    f = alerts_host
    before = f.path.read_bytes()
    response = request(f.browser(mode), case)
    assert response.status_code == 200, response.text
    assert response.headers['cache-control'] == 'no-store'
    if case[0] == 'get':
        assert response.json() == {'alerts': f.rows[:2], 'count': 2}
        assert f.path.read_bytes() == before
    else:
        assert response.json() == {'ok': True, 'dismissed': ALERT_ID if case[2] == 'dismiss_alert' else 2}
        expected = [dict(row) for row in f.rows]
        expected[0]['dismissed'] = True
        if case[2] == 'dismiss_all_alerts': expected[1]['dismissed'] = True
        assert json.loads(f.path.read_bytes()) == expected


def test_missing_alert_is_private_404_without_rewriting(alerts_host):
    f = alerts_host
    before = f.path.read_bytes()
    response = f.browser().post('/status/alerts/PRIVATE-missing-id/dismiss')
    private_error(response, 404)
    assert response.json() == {'detail': 'Alert not found'}
    assert f.path.read_bytes() == before


def test_repeated_confirmed_dismissals_are_noops_with_truthful_counts(alerts_host):
    f = alerts_host
    client = f.browser()
    assert request(client, CASES[1]).json() == {'ok': True, 'dismissed': ALERT_ID}
    once = f.path.read_bytes()
    assert request(client, CASES[1]).json() == {'ok': True, 'dismissed': ALERT_ID}
    assert f.path.read_bytes() == once
    assert request(client, CASES[2]).json() == {'ok': True, 'dismissed': 1}
    all_done = f.path.read_bytes()
    assert request(client, CASES[2]).json() == {'ok': True, 'dismissed': 0}
    assert f.path.read_bytes() == all_done


@pytest.mark.parametrize('case', CASES)
def test_fresh_missing_alert_store_is_read_only_empty(alerts_host, case):
    f = alerts_host
    f.path.unlink()
    response = request(f.browser(), case)
    assert response.status_code == (404 if case[2] == 'dismiss_alert' else 200), response.text
    assert response.headers['cache-control'] == 'no-store'
    if case[0] == 'get': assert response.json() == {'alerts': [], 'count': 0}
    elif case[2] == 'dismiss_all_alerts': assert response.json() == {'ok': True, 'dismissed': 0}
    assert not f.path.exists()


@pytest.mark.parametrize('case', CASES)
@pytest.mark.parametrize('damage', [b'{"PRIVATE":broken', b'{}', b'[false]',
    b'[{"id":"same","message":"PRIVATE"},{"id":"same","message":"other"}]'],
    ids=['malformed', 'wrong-root', 'wrong-row', 'duplicate-ids'])
def test_damaged_alert_store_is_unavailable_and_preserved(alerts_host, case, damage):
    f = alerts_host
    f.path.write_bytes(damage)
    private_error(request(f.browser(), case), 503)
    assert f.path.read_bytes() == damage


@pytest.mark.parametrize('case', CASES)
def test_unexpected_service_error_is_generic_and_noncached(alerts_host, monkeypatch, case):
    before = alerts_host.path.read_bytes()
    monkeypatch.setattr(S, case[2], Mock(side_effect=RuntimeError('PRIVATE alert failure')))
    private_error(request(alerts_host.browser(), case), 503)
    assert alerts_host.path.read_bytes() == before


@pytest.mark.parametrize('case', CASES)
@pytest.mark.parametrize('change', ['cookie', 'owner', 'epoch', 'security'])
@pytest.mark.parametrize('fails', [False, True])
def test_final_success_and_error_disclosure_keep_original_authority(alerts_host, monkeypatch, case, change, fails):
    f = alerts_host
    client = f.browser('open-local' if change == 'epoch' else 'pin-local')
    before = f.path.read_bytes()
    def service(*args, check=None):
        assert callable(check)
        check()
        revoke(f, change)
        if fails: raise RuntimeError('PRIVATE unfinished service')
        return f.rows if case[0] == 'get' else True if case[2] == 'dismiss_alert' else 2
    monkeypatch.setattr(S, case[2], service)
    private_error(request(client, case), 503 if change == 'security' else 401)
    assert f.path.read_bytes() == before


@pytest.mark.parametrize('case', CASES)
@pytest.mark.parametrize('change', ['cookie', 'epoch'])
def test_revocation_while_waiting_for_store_lock_stops_read_or_effect(alerts_host, monkeypatch, case, change):
    f = alerts_host
    client = f.browser('open-local' if change == 'epoch' else 'pin-local')
    before = f.path.read_bytes()
    original = store.LOCK
    class WaitingLock:
        def __enter__(self):
            original.acquire()
            revoke(f, change)
        def __exit__(self, *args): original.release()
    monkeypatch.setattr(store, 'LOCK', WaitingLock())
    snapshot = Mock(side_effect=AssertionError('Revoked waiter reached private read'))
    monkeypatch.setattr(store, '_snapshot', snapshot)
    private_error(request(client, case), 401)
    snapshot.assert_not_called()
    assert f.path.read_bytes() == before


@pytest.mark.parametrize('case', CASES)
@pytest.mark.parametrize('change', ['cookie', 'epoch', 'security'])
def test_revocation_after_original_read_stops_disclosure_and_dismissal(alerts_host, monkeypatch, case, change):
    f = alerts_host
    client = f.browser('open-local' if change == 'epoch' else 'pin-local')
    before = f.path.read_bytes()
    original = store._snapshot
    def snapshot(*args, **kwargs):
        value = original(*args, **kwargs)
        revoke(f, change)
        return value
    monkeypatch.setattr(store, '_snapshot', snapshot)
    private_error(request(client, case), 503 if change == 'security' else 401)
    assert f.path.read_bytes() == before


@pytest.mark.parametrize('case', CASES[1:])
@pytest.mark.parametrize('stage_number', [1, 2])
@pytest.mark.parametrize('change', ['cookie', 'epoch'])
def test_revocation_during_dismissal_staging_prevents_commit(alerts_host, monkeypatch, case, stage_number, change):
    f = alerts_host
    client = f.browser('open-local' if change == 'epoch' else 'pin-local')
    before = f.path.read_bytes()
    original, calls = store.os.fsync, []
    def fsync(fd):
        original(fd)
        calls.append(fd)
        if len(calls) == stage_number: revoke(f, change)
    monkeypatch.setattr(store.os, 'fsync', fsync)
    private_error(request(client, case), 401)
    assert len(calls) == stage_number and f.path.read_bytes() == before
    assert str(f.path) not in store._UNCERTAIN


@pytest.mark.parametrize('case', CASES[1:])
@pytest.mark.parametrize('change', ['cookie', 'security'])
def test_confirmed_dismissal_is_retained_when_response_is_denied(alerts_host, monkeypatch, case, change):
    f = alerts_host
    client = f.browser()
    original, calls = store._publish, []
    def publish(*args, **kwargs):
        original(*args, **kwargs)
        calls.append(True)
        revoke(f, change)
    monkeypatch.setattr(store, '_publish', publish)
    private_error(request(client, case), 503 if change == 'security' else 401)
    assert calls == [True] and str(f.path) not in store._UNCERTAIN
    saved = json.loads(f.path.read_bytes())
    assert saved[0]['dismissed'] is True
    assert saved[1]['dismissed'] is (case[2] == 'dismiss_all_alerts')
    assert saved[0]['future'] == f.rows[0]['future']


@pytest.mark.parametrize('case', CASES[1:])
@pytest.mark.parametrize('landed', [False, True])
def test_uncertain_dismissal_blocks_retry_and_reads(alerts_host, monkeypatch, case, landed):
    f = alerts_host
    client = f.browser()
    before = f.path.read_bytes()
    original, calls = store._publish, []
    def publish(*args, **kwargs):
        if landed: original(*args, **kwargs)
        calls.append(True)
        raise OSError('PRIVATE ambiguous persistence')
    monkeypatch.setattr(store, '_publish', publish)
    private_error(request(client, case), 503)
    saved = f.path.read_bytes()
    assert (saved != before) is landed
    assert str(f.path) in store._UNCERTAIN
    for retry in CASES: private_error(request(client, retry), 503)
    assert calls == [True] and f.path.read_bytes() == saved
    assert any(path.name != f.path.name and 'alert' in path.name for path in f.root.iterdir())


@pytest.mark.parametrize('case', CASES)
@pytest.mark.parametrize('mode', ['anonymous', 'pin-off-lan', 'bearer', 'pin-https', 'open-local'])
def test_effective_main_alert_routes_keep_browser_policy(alerts_host, monkeypatch, app, case, mode):
    import companion_auth
    f = alerts_host
    before = f.path.read_bytes()
    if mode == 'bearer': monkeypatch.setattr(companion_auth, 'credential_owner', lambda _: 'owner')
    response = request(f.browser(mode, target=app), case)
    expected = 200 if mode in {'pin-https', 'open-local'} else 401 if mode == 'anonymous' else 403
    assert response.status_code == expected, response.text
    assert response.headers['cache-control'] == 'no-store'
    if expected != 200: assert 'PRIVATE' not in response.text and f.path.read_bytes() == before


@pytest.mark.parametrize('case', CASES)
def test_effective_main_invalid_bearer_cannot_fall_back_to_browser_cookie(alerts_host, monkeypatch, app, case):
    import companion_auth
    before = alerts_host.path.read_bytes()
    def invalid(_): raise HTTPException(401, 'Credential revoked')
    monkeypatch.setattr(companion_auth, 'credential_owner', invalid)
    private_error(request(alerts_host.browser('bearer', target=app), case), 401)
    assert alerts_host.path.read_bytes() == before
