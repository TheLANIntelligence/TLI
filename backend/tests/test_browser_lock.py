"""Real browser-session revocation; temporary PIN data and no application workers."""
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import tli_state as S
import companion_auth
from routers.system_routes import router


@pytest.fixture
def browser(tmp_path, monkeypatch):
    monkeypatch.setattr(S, 'DATA_DIR', str(tmp_path))
    monkeypatch.setattr(S, 'PIN_CONFIG_FILE', tmp_path / 'tli_pin.json')
    monkeypatch.setattr(S, '_active_sessions', {})
    monkeypatch.setattr(S, 'TLS_ENABLED', True)
    S.save_pin_config('a' * 64, 'b' * 64)
    app = FastAPI()
    app.middleware('http')(companion_auth.validate_authorization)
    app.include_router(router)
    with TestClient(app, base_url='https://testserver') as client:
        yield client


def headers(token, **values):
    return {'Cookie': 'tli_session=' + token, **values}


def test_lock_revokes_only_requesting_browser_and_clears_cookie(browser):
    mine = S.create_session_token('alice')
    other = S.create_session_token('alice')
    separate_owner = S.create_session_token('bob')
    before = Path(S.PIN_CONFIG_FILE).read_bytes()
    result = browser.post('/system/pin/lock', headers=headers(mine, Origin='https://testserver'))
    assert result.status_code == 200 and result.json() == {'ok': True, 'locked': True}
    assert 'Max-Age=0' in result.headers['set-cookie'] and 'HttpOnly' in result.headers['set-cookie']
    assert result.headers['cache-control'] == 'no-store'
    assert not S.validate_session_token(mine)
    assert S.validate_session_token(other) and S.validate_session_token(separate_owner)
    assert Path(S.PIN_CONFIG_FILE).read_bytes() == before
    assert browser.post('/system/pin/lock', headers=headers(mine)).status_code == 401


def test_lock_requires_real_cookie_and_rejects_cross_site(browser):
    mine = S.create_session_token()
    assert browser.post('/system/pin/lock').status_code == 401
    assert browser.post('/system/pin/lock', headers=headers('invalid')).status_code == 401
    for extra in ({'Origin': 'https://different.test'}, {'Sec-Fetch-Site': 'cross-site'}):
        assert browser.post('/system/pin/lock', headers=headers(mine, **extra)).status_code == 403
        assert S.validate_session_token(mine)


def test_lock_does_not_revoke_companion_or_fall_back_from_invalid_bearer(browser, monkeypatch):
    mine = S.create_session_token()
    monkeypatch.setattr(companion_auth, 'credential_owner', lambda credential: 'alice')
    result = browser.post('/system/pin/lock', headers=headers(mine, Authorization='Bearer synthetic'))
    assert result.status_code == 403 and S.validate_session_token(mine)
    result = browser.post('/system/pin/lock', headers=headers(mine, Authorization='Invalid synthetic'))
    assert result.status_code == 401 and S.validate_session_token(mine)


@pytest.mark.parametrize('contents,status', [(b'{bad PIN data', 503), (b'{"enabled": false}', 409)])
def test_lock_refuses_unreadable_or_disabled_pin_without_changing_state(browser, contents, status):
    mine = S.create_session_token()
    Path(S.PIN_CONFIG_FILE).write_bytes(contents)
    result = browser.post('/system/pin/lock', headers=headers(mine))
    assert result.status_code == status
    assert S.validate_session_token(mine)
    assert Path(S.PIN_CONFIG_FILE).read_bytes() == contents
