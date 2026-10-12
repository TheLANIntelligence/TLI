"""Browser authority contract; every service and helper mutation is mocked."""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import network_setup as N
import tli_state as S
from routers import network_setup_routes as R
from routers.system_routes import require_session

PREFIX = '/api/network-setup/v1'
ORIGIN = 'http://localhost:8000'


@pytest.fixture
def local(monkeypatch):
    app = FastAPI()
    app.include_router(R.router)
    app.dependency_overrides[require_session] = lambda: 'local'
    monkeypatch.setattr(S, 'SERVER_BIND_HOST', '127.0.0.1', raising=False)
    monkeypatch.setattr(S, 'SERVER_BIND_PORT', 8000)
    monkeypatch.setattr(S, 'TLS_ENABLED', False)
    monkeypatch.setattr(S, 'load_pin_config', lambda: {'enabled': True})
    monkeypatch.setattr(S, 'validate_session_token', lambda token: token in {'session-one', 'session-two'})
    monkeypatch.setattr(S, 'get_session_user_id', lambda token: 'local')
    calls = []
    monkeypatch.setattr(N, 'status', lambda *args: {'schema_version': 1})
    monkeypatch.setattr(N, 'preview', lambda *args, **kwargs: calls.append(('preview', args, kwargs)) or {'preview_id': 'a' * 32})
    monkeypatch.setattr(N, 'confirm', lambda *args: calls.append(('confirm', args)) or {'status': 'accepted'})
    monkeypatch.setattr(N, 'dispatch', lambda *args: calls.append(('dispatch', args)))
    monkeypatch.setattr(N, 'receipt', lambda *args: calls.append(('receipt', args)) or {'status': 'completed'})
    client = TestClient(app, base_url=ORIGIN, client=('127.0.0.1', 50123))
    client.cookies.set('tli_session', 'session-one')
    return app, client, calls


@pytest.mark.parametrize('headers', [
    {'Authorization': 'Bearer tlic_test'}, {'Origin': 'null'}, {'Origin': 'https://evil.example'},
    {'Host': 'evil.example:8000'}, {'Host': 'localhost:9999'}, {'X-Forwarded-For': '127.0.0.1'},
    {'Forwarded': 'for=127.0.0.1'}, {'Sec-Fetch-Site': 'cross-site'},
])
def test_nonlocal_authority_rejected(local, headers):
    _, client, calls = local
    assert client.get(PREFIX + '/status', headers=headers).status_code == 403
    assert client.post(PREFIX + '/preview', json={'action': 'prepare'}, headers={**headers, 'Origin': headers.get('Origin', ORIGIN)}).status_code == 403
    assert not calls


@pytest.mark.parametrize('address', ['192.168.1.9', '8.8.8.8', 'testclient'])
def test_remote_socket_rejected(local, address):
    app, _, calls = local
    client = TestClient(app, base_url=ORIGIN, client=(address, 1234))
    assert client.get(PREFIX + '/status').status_code == 403
    assert not calls


def test_pin_and_local_owner_required_even_when_dependency_is_overridden(local, monkeypatch):
    app, client, calls = local
    app.dependency_overrides[require_session] = lambda: 'other'
    assert client.get(PREFIX + '/status').status_code == 403
    app.dependency_overrides[require_session] = lambda: 'local'
    client.cookies.clear()
    assert client.post(PREFIX + '/preview', json={'action': 'prepare'}, headers={'Origin': ORIGIN}).status_code == 401
    assert client.get(PREFIX + '/receipt/' + 'a' * 32).status_code == 401
    monkeypatch.setattr(S, 'load_pin_config', lambda: {'enabled': False})
    assert client.get(PREFIX + '/status').status_code == 200
    assert client.post(PREFIX + '/preview', json={'action': 'prepare'}, headers={'Origin': ORIGIN}).status_code == 409
    assert not calls


def test_strict_confirmation_and_no_secret_service_arguments(local):
    _, client, calls = local
    assert client.post(PREFIX + '/preview', json={'action': 'prepare'}).status_code == 403
    assert client.post(PREFIX + '/preview', json={'action': 'prepare', 'command': 'bad'}, headers={'Origin': ORIGIN}).status_code == 422
    assert client.post(PREFIX + '/confirm', json={'preview_id': 'a' * 32, 'request_id': '../bad'}, headers={'Origin': ORIGIN}).status_code == 422
    result = client.post(PREFIX + '/preview', json={'action': 'prepare', 'port': 8443}, headers={'Origin': ORIGIN})
    assert result.status_code == 200 and result.headers['cache-control'] == 'no-store'
    assert 'session-one' not in str(calls)
    result = client.post(PREFIX + '/confirm', json={'preview_id': 'a' * 32, 'request_id': 'b' * 32}, headers={'Origin': ORIGIN})
    assert result.status_code == 202
    assert [row[0] for row in calls] == ['preview', 'confirm', 'dispatch']


def test_receipt_resumes_after_fresh_local_pin_without_reconfirmation(local):
    _, client, calls = local
    client.cookies.set('tli_session', 'session-two')
    result = client.get(PREFIX + '/receipt/' + 'b' * 32)
    assert result.status_code == 200 and result.json()['status'] == 'completed'
    assert [row[0] for row in calls] == ['receipt']


def test_duplicate_confirmation_does_not_redispatch(local, monkeypatch):
    _, client, calls = local
    monkeypatch.setattr(N, 'confirm', lambda *args: {'status': 'accepted', 'duplicate': True})
    response = client.post(PREFIX + '/confirm', json={'preview_id': 'a' * 32, 'request_id': 'b' * 32}, headers={'Origin': ORIGIN})
    assert response.status_code == 202 and not calls
