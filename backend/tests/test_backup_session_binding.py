"""Real session boundaries, synthetic encrypted stores, and no live services."""
import asyncio
import base64
from collections import OrderedDict
import hashlib
import json
import os
from pathlib import Path
import time

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest
from starlette.requests import Request

import tli_state as S
from companion_auth import operation_access
from intelligence import backups, recovery
from routers import backup_routes, vault_backup_routes, system_routes
from routers.system_routes import require_session
from tests.test_recovery import fixture as recovery_fixture, archive as recovery_archive, PASSWORD as RECOVERY_PASSWORD, tree

PASSWORD = 'Synthetic independent archive password'


@pytest.fixture
def session(monkeypatch):
    monkeypatch.setattr(S, '_active_sessions', {})
    monkeypatch.setattr(S, 'load_pin_config', lambda: {'enabled': True})
    monkeypatch.setattr(backups, '_recent_requests', OrderedDict())
    return S.create_session_token('synthetic-owner')


def cookie_request(token=None):
    return Request({'type':'http','method':'POST','scheme':'https','path':'/',
                    'headers':[] if token is None else [(b'cookie',f'tli_session={token}'.encode())],
                    'server':('synthetic.invalid',443), 'client':('127.0.0.1',50100)})


@pytest.mark.parametrize('vault_callback', [False, True])
def test_original_cookie_cannot_fall_back_to_open_local_authority(monkeypatch, vault_callback):
    monkeypatch.setattr(S, '_active_sessions', {})
    monkeypatch.setattr(S, 'load_pin_config', lambda: {'enabled': False})
    token = S.create_session_token('local')
    request = cookie_request(token)
    check = vault_backup_routes._authorization(request, 'local') if vault_callback else operation_access(request, 'local')
    check(True) if vault_callback else check()
    S.revoke_session_token(token)
    assert require_session(token, request) == 'local'  # Ordinary open-local reads stay compatible.
    with pytest.raises(HTTPException) as error:
        check(True) if vault_callback else check()
    assert error.value.status_code == 401
    # A new explicit request can use deliberately open-local admission. This
    # does not replace the revoked credential retained by the original callback.
    operation_access(request, 'local')()
    with pytest.raises(HTTPException): check(True) if vault_callback else check()
    operation_access(cookie_request(), 'local')()  # Deliberate no-cookie local access is preserved.


def test_revocation_between_validity_and_owner_lookup_cannot_adopt_local(monkeypatch):
    monkeypatch.setattr(S, '_active_sessions', {})
    monkeypatch.setattr(S, 'load_pin_config', lambda: {'enabled':False})
    token = S.create_session_token('local')
    original = S.get_session_user_id
    def revoked_owner_lookup(value):
        S.revoke_session_token(value)
        return original(value)  # Legacy getter deliberately falls back to local.
    monkeypatch.setattr(S, 'get_session_user_id', revoked_owner_lookup)
    with pytest.raises(HTTPException) as error: operation_access(cookie_request(token), 'local')
    assert error.value.status_code == 401


@pytest.mark.parametrize('vault', [False, True])
def test_two_browsers_pin_removal_stops_inflight_but_allows_new_open_request(monkeypatch, tmp_path, vault):
    """Real PIN cookies/routes; synthetic PIN storage and no private archive work."""
    pin, salt = '123456', 'a' * 64
    monkeypatch.setattr(S, '_active_sessions', {})
    monkeypatch.setattr(S, 'TLS_ENABLED', True)
    monkeypatch.setattr(S, 'DATA_DIR', str(tmp_path))
    monkeypatch.setattr(S, 'PIN_CONFIG_FILE', tmp_path / 'pin.json')
    S.save_pin_config(system_routes._hash_pin(pin, salt), salt)
    monkeypatch.setattr(backups, '_recent_requests', OrderedDict())
    monkeypatch.setattr(vault_backup_routes.archive, '_requests', OrderedDict())
    calls = []
    def create(owner, password, format=None, *, authorize):
        authorize()
        calls.append(owner)
        return b'synthetic encrypted archive'
    def check_vault(owner, authorize):
        authorize(True)
        calls.append(owner)
        return {'ok': True, 'scope': 'synthetic source check'}
    monkeypatch.setattr(backups, 'create_archive', create)
    monkeypatch.setattr(vault_backup_routes.archive, 'check_source', check_vault)
    routes = vault_backup_routes if vault else backup_routes
    original_body = routes._small_json
    app = FastAPI()
    app.include_router(system_routes.router)
    app.include_router(backup_routes.router)
    app.include_router(vault_backup_routes.router)
    with TestClient(app, base_url='https://synthetic.invalid', headers={'Origin':'https://synthetic.invalid'}) as browser_a, TestClient(app, base_url='https://synthetic.invalid', headers={'Origin':'https://synthetic.invalid'}) as browser_b:
        for browser in (browser_a, browser_b):
            assert browser.post('/system/pin/verify', json={'pin': pin}).status_code == 200
        token_b = browser_b.cookies.get('tli_session')
        assert token_b and S.validate_session_token(token_b)
        removed = False
        async def remove_during_body(request):
            nonlocal removed
            body = await original_body(request)
            if not removed:
                removed = True
                assert browser_a.post('/system/pin/remove', json={'pin': pin}).status_code == 200
            return body
        monkeypatch.setattr(routes, '_small_json', remove_during_body)
        path = '/vault/backups/check' if vault else '/api/intelligence/backups/create'
        fields = {'request_id': 'before-pin-removal-0001'}
        if not vault: fields['password'] = PASSWORD
        assert browser_b.post(path, json=fields).status_code == 401
        assert removed and not calls and not S.validate_session_token(token_b)
        assert browser_a.cookies.get('tli_session') is None
        assert browser_b.cookies.get('tli_session') == token_b  # The other browser retains its HttpOnly cookie.
        # User deliberately starts a new operation; there is no automatic retry.
        fields['request_id'] = 'after-pin-removal-0002'
        assert browser_b.post(path, json=fields).status_code == 200
        assert calls == ['local']
        # Explicit malformed/invalid Bearer authority never uses anonymous access.
        for header in ['broken', 'Bearer invalid-synthetic-credential']:
            assert browser_b.post(path, json=fields, headers={'Authorization': header}).status_code == 401
        assert calls == ['local']
        S.save_pin_config(system_routes._hash_pin(pin, salt), salt)
        assert browser_b.post(path, json=fields).status_code == 401
        assert calls == ['local']


@pytest.mark.parametrize('phase', ['body', 'worker_completion'])
@pytest.mark.parametrize('format', [None, 'saved-work-v2'])
def test_real_http_backup_revocation_returns_no_archive(tmp_path, monkeypatch, session, phase, format):
    monkeypatch.setattr(S, 'DATA_DIR', str(tmp_path))
    monkeypatch.setattr(S, 'CONVERSATIONS_FILE', str(tmp_path / 'conversations.json'))
    monkeypatch.setattr(backups.data_protection, 'is_windows', lambda: False)
    monkeypatch.setattr(backups.data_health, '_host', lambda: {'id':'synthetic-host','name':'Synthetic host'})
    key, nonce = b'Z' * 32, os.urandom(12)
    (tmp_path / 'memory_key.bin').write_bytes(key)
    note = {'facts':[{'id':'audit-note','text':'Synthetic preserved note','deleted':False}]}
    blob = nonce + AESGCM(key).encrypt(nonce, json.dumps(note).encode(), None)
    Path(S.memory_path_for_user('synthetic-owner')).write_text(json.dumps({'_tli_enc':1,'data':base64.b64encode(blob).decode()}))
    before = tree(tmp_path)
    read_body, create = backup_routes._small_json, backups.create_archive
    calls = []
    async def body_then_revoke(request):
        value = await read_body(request)
        if phase == 'body': S.revoke_session_token(session)
        return value
    def archive_then_revoke(*args, **kwargs):
        calls.append('private_work')
        result = create(*args, **kwargs)
        assert result.startswith(backups.MAGIC if format is None else backups.MAGIC_V2)
        S.revoke_session_token(session)
        return result
    monkeypatch.setattr(backup_routes, '_small_json', body_then_revoke)
    monkeypatch.setattr(backups, 'create_archive', archive_then_revoke)
    app = FastAPI(); app.include_router(backup_routes.router)
    fields = {'password':PASSWORD,'request_id':'real-http-revocation-0001'}
    if format: fields['format'] = format
    with TestClient(app, base_url='https://synthetic.invalid', cookies={'tli_session':session}) as client:
        response = client.post('/api/intelligence/backups/create', json=fields)
    assert response.status_code == 401 and 'application/vnd.tli' not in response.headers.get('content-type','')
    assert calls == ([] if phase == 'body' else ['private_work'])
    assert tree(tmp_path) == before


@pytest.mark.parametrize('path', ['/api/intelligence/backups/verify', '/api/intelligence/backups/recovery/review',
    '/api/intelligence/backups/recovery/create', '/vault/backups/verify', '/vault/backups/recovery/review', '/vault/backups/recovery/create'])
def test_revoked_upload_closes_ciphertext_spool_before_private_work(monkeypatch, session, path):
    parse = backup_routes.MultiPartParser.parse
    forms = []
    async def parsed_then_revoke(parser):
        form = await parse(parser)
        forms.append(form)
        S.revoke_session_token(session)
        return form
    monkeypatch.setattr(backup_routes.MultiPartParser, 'parse', parsed_then_revoke)
    monkeypatch.setattr(backups, 'verify_archive', lambda *a, **k: pytest.fail('Revoked upload must not decrypt'))
    monkeypatch.setattr(recovery, 'review_archive', lambda *a, **k: pytest.fail('Revoked upload must not review'))
    monkeypatch.setattr(recovery, 'create_copy', lambda *a, **k: pytest.fail('Revoked upload must not create'))
    monkeypatch.setattr(vault_backup_routes.archive, 'scan_archive', lambda *a, **k: pytest.fail('Revoked upload must not decrypt Vault'))
    app = FastAPI(); app.include_router(backup_routes.router); app.include_router(vault_backup_routes.router)
    fields = {'password':PASSWORD,'request_id':'upload-revocation-0001'}
    if '/recovery/' in path: fields['destination'] = 'J:/synthetic/never-created'
    if path.endswith('/create'):
        fields['review_token'] = 'synthetic-unused-review'
        if path.startswith('/vault/'): fields['new_vault_password'] = PASSWORD
    with TestClient(app, base_url='https://synthetic.invalid', cookies={'tli_session':session}) as client:
        response = client.post(path, data=fields, files={'file':('fixture.encrypted',b'synthetic ciphertext')})
    assert response.status_code == 401
    assert len(forms) == 1 and forms[0]['file'].file.closed


@pytest.mark.parametrize('vault', [False, True])
def test_mid_file_upload_revocation_closes_parser_owned_spool(monkeypatch, session, vault):
    parse = backup_routes.MultiPartParser.parse
    parsers = []
    async def capture_parser(parser):
        parsers.append(parser)
        return await parse(parser)
    monkeypatch.setattr(backup_routes.MultiPartParser, 'parse', capture_parser)
    prefix = b'--boundary\r\nContent-Disposition: form-data; name="file"; filename="fixture.encrypted"\r\nContent-Type: application/octet-stream\r\n\r\nsynthetic encrypted partial upload'
    reads = []
    async def receive():
        reads.append(1)
        if len(reads) == 1:
            return {'type':'http.request','body':prefix,'more_body':True}
        assert parsers[0]._files_to_close_on_error and not parsers[0]._files_to_close_on_error[0].closed
        S.revoke_session_token(session)
        return {'type':'http.request','body':b'\r\n--boundary--\r\n','more_body':False}
    request = Request({'type':'http','method':'POST','scheme':'https','path':'/',
        'headers':[(b'cookie',f'tli_session={session}'.encode()),(b'content-type',b'multipart/form-data; boundary=boundary')],
        'server':('synthetic.invalid',443), 'client':('127.0.0.1',50100)}, receive)
    owner = require_session(session, request)
    action = vault_backup_routes.verify if vault else backup_routes.verify_backup
    with pytest.raises(HTTPException) as error: asyncio.run(action(request, owner))
    assert error.value.status_code == 401 and len(reads) == 2
    assert len(parsers[0]._files_to_close_on_error) == 1 and parsers[0]._files_to_close_on_error[0].closed


@pytest.mark.parametrize('phase', ['source_read', 'key_derivation', 'verify_readback'])
def test_revocation_inside_private_backup_work_preserves_sources(tmp_path, monkeypatch, session, phase):
    from tests.test_recovery import archive
    # This helper builds an independent valid synthetic archive; no saved source is read.
    encrypted, _ = archive()
    authorize = operation_access(cookie_request(session), 'synthetic-owner')
    if phase == 'source_read':
        monkeypatch.setattr(S, 'DATA_DIR', str(tmp_path))
        monkeypatch.setattr(S, 'CONVERSATIONS_FILE', str(tmp_path/'conversations.json'))
        source = Path(S.memory_path_for_user('synthetic-owner'))
        source.write_text(json.dumps({'facts':[]}))
        before = tree(tmp_path)
        read = backups._read_existing
        calls = []
        def revoke_after_read(*args, **kwargs):
            result = read(*args, **kwargs)
            calls.append(args[0]); S.revoke_session_token(session)
            return result
        monkeypatch.setattr(backups, '_read_existing', revoke_after_read)
        action = lambda: backups.create_archive('synthetic-owner', PASSWORD, authorize=authorize)
    elif phase == 'key_derivation':
        derive = backups._key
        def revoke_after_key(*args):
            key = derive(*args); S.revoke_session_token(session); return key
        monkeypatch.setattr(backups, '_key', revoke_after_key)
        action = lambda: backups.verify_archive(encrypted, RECOVERY_PASSWORD, authorize=authorize)
    else:
        readback = backups._isolated_readback
        def revoke_after_readback(*args):
            result = readback(*args); S.revoke_session_token(session); return result
        monkeypatch.setattr(backups, '_isolated_readback', revoke_after_readback)
        action = lambda: backups.verify_archive(encrypted, RECOVERY_PASSWORD, authorize=authorize)
    with pytest.raises(HTTPException) as error: action()
    assert error.value.status_code == 401
    if phase == 'source_read':
        assert len(calls) == 1 and tree(tmp_path) == before


@pytest.mark.parametrize('phase', ['current_readback', 'receipt_write'])
def test_real_http_recovery_revocation_never_publishes(recovery_fixture, monkeypatch, session, phase):
    fixture = recovery_fixture
    encrypted, _ = recovery_archive()
    before = tree(fixture.live)
    app = FastAPI(); app.include_router(backup_routes.router)
    with TestClient(app, base_url='https://synthetic.invalid', cookies={'tli_session':session}) as client:
        fields = {'password':RECOVERY_PASSWORD,'request_id':'late-recovery-review-0001','destination':str(fixture.target)}
        reviewed = client.post('/api/intelligence/backups/recovery/review', data=fields, files={'file':('fixture.tlibackup',encrypted)})
        assert reviewed.status_code == 200 and not fixture.target.exists()
        reached = []
        readback, write = recovery._readback, recovery._StageLease.write
        def readback_then_revoke(*args):
            result = readback(*args)
            if phase == 'current_readback': reached.append(phase); S.revoke_session_token(session)
            return result
        def write_then_revoke(lease, relative, raw):
            result = write(lease, relative, raw)
            if phase == 'receipt_write' and relative == 'recovery-receipt.json':
                reached.append(phase); S.revoke_session_token(session)
            return result
        monkeypatch.setattr(recovery, '_readback', readback_then_revoke)
        monkeypatch.setattr(recovery._StageLease, 'write', write_then_revoke)
        fields.update(request_id='late-recovery-create-0001',review_token=reviewed.json()['review_token'])
        result = client.post('/api/intelligence/backups/recovery/create', data=fields, files={'file':('fixture.tlibackup',encrypted)})
    assert result.status_code == 401 and reached == [phase]
    assert not fixture.target.exists() and not list(fixture.parent.glob('.tli-recovery-*'))
    assert tree(fixture.live) == before
    assert fields['review_token'] not in recovery._reviews


@pytest.mark.parametrize('before_headers', [False, True])
def test_download_revocation_stops_next_chunk_and_releases_owned_ciphertext(tmp_path, monkeypatch, session, before_headers):
    routes = vault_backup_routes
    monkeypatch.setattr(routes, '_downloads', OrderedDict())
    path = tmp_path/'prepared.encrypted'; path.write_bytes(b'synthetic-ciphertext-' * 20)
    monkeypatch.setattr(routes.archive, 'CHUNK', 40)
    token = 'synthetic-download-token'
    routes._downloads[token] = {'path':path,'owner':'synthetic-owner','expires':time.monotonic()+60,
        'sending':True,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
    response = routes._Download(path, token=token, authorize=operation_access(cookie_request(session), 'synthetic-owner'))
    if before_headers: S.revoke_session_token(session)
    sent = []
    headers = []
    async def receive():
        await asyncio.Event().wait()
    async def send(message):
        if message['type'] == 'http.response.start': headers.append(message)
        if message['type'] == 'http.response.body' and message.get('body'):
            sent.append(message['body'])
            S.revoke_session_token(session)
    async def stream():
        try:
            await response({'type':'http','asgi':{'spec_version':'2.4'}}, receive, send)
        except HTTPException as error:
            assert error.status_code == 401
        else:
            pytest.fail('Revoked stream must not finish successfully')
    asyncio.run(stream())
    if before_headers:
        assert not sent and not headers
    else:
        assert len(sent) == 1 and len(sent[0]) == 40  # Already-sent bytes cannot be recalled.
    assert not path.exists() and token not in routes._downloads and response.handle.closed
