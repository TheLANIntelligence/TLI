"""Synthetic real-route image authorization and whole-question boundaries."""
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import json
from threading import Event
import time
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import companion_auth
import tli_state as S
from ai import ai_routes
from intelligence import chat, models, vision, store
from routers import chat_routes
from tests.test_screenshot_help import isolated, request_body, options, PROVIDER


PATHS = ['/api/ai/chat', '/api/ai/chat/stream', '/chat']


def assert_refused(response, path):
    if path.endswith('/stream'):
        frames = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
        assert [frame['type'] for frame in frames] == ['error']
        assert 'original access' in frames[0]['detail']
    else:
        assert response.status_code == 401, response.text


def no_answer_saved():
    return not any(turn.get('role') == 'assistant' for row in S.load_conversations().values()
                   for turn in row.get('messages', []))


@pytest.mark.parametrize('path', PATHS)
@pytest.mark.parametrize('guided', [False, True])
@pytest.mark.parametrize('phase', ['decode', 'provider_review', 'retention', 'provider_response'])
def test_revoked_original_cookie_stops_later_image_work(path, guided, phase, app, monkeypatch):
    # PIN-off deliberately makes a newly admitted request local. An already
    # captured valid cookie must still stop; it cannot adopt that open authority.
    monkeypatch.setattr(S, '_active_sessions', {})
    token = S.create_session_token('local')
    calls = Counter()
    sanitize, retain = vision.sanitize, vision.retain
    def revoke(at):
        if phase == at:
            S.revoke_session_token(token)
    def decode(*args, **kwargs):
        result = sanitize(*args, **kwargs)
        calls['decode'] += 1
        revoke('decode')
        return result
    def provider():
        calls['provider_review'] += 1
        revoke('provider_review')
        return dict(PROVIDER)
    def retention(*args, **kwargs):
        result = retain(*args, **kwargs)
        calls['retention'] += 1
        revoke('retention')
        return result
    def post(*args, **kwargs):
        calls['send'] += 1
        revoke('provider_response')
        return SimpleNamespace(status_code=200, raise_for_status=lambda: None,
            json=lambda: {'choices': [{'message': {'content': 'Synthetic image answer.'}}]})
    monkeypatch.setattr(vision, 'sanitize', decode)
    monkeypatch.setattr(vision, 'retain', retention)
    monkeypatch.setattr(models, 'image_provider', provider)
    monkeypatch.setattr(chat.requests, 'post', post)
    body = request_body(conversation_id='original-image-authority')
    if not guided:
        body.update(screenshot=None, image_provider_key=options()['provider_key'], use_saved_memory=False)
    with TestClient(app, base_url='https://screenshot.invalid', cookies={'tli_session': token}, raise_server_exceptions=False) as browser:
        response = browser.post(path, json=body)
    assert_refused(response, path)
    assert calls['send'] == int(phase == 'provider_response')
    assert calls['retention'] == int(phase in ('retention', 'provider_response'))
    assert no_answer_saved() and not vision.images('local')


def test_deferred_stream_keeps_authority_captured_before_headers(monkeypatch):
    monkeypatch.setattr(S, '_active_sessions', {})
    token = S.create_session_token('local')
    calls = []
    monkeypatch.setattr(vision, 'sanitize', lambda *a, **k: calls.append('decode') or {'b64': 'synthetic', 'mime': 'image/jpeg'})
    monkeypatch.setattr(chat.requests, 'post', lambda *a, **k: calls.append('send') or SimpleNamespace(
        status_code=200, raise_for_status=lambda: None,
        json=lambda: {'choices': [{'message': {'content': 'Must not be published.'}}]}))
    # Use the real router without outer buffering middleware, so response start
    # is the precise boundary immediately before StreamingResponse iterates it.
    app = FastAPI()
    app.include_router(ai_routes.router)
    class RevokeAtHeaders:
        async def __call__(self, scope, receive, send):
            async def boundary(message):
                if message['type'] == 'http.response.start':
                    S.revoke_session_token(token)
                await send(message)
            await app(scope, receive, boundary)
    with TestClient(RevokeAtHeaders(), base_url='https://screenshot.invalid', cookies={'tli_session': token}, raise_server_exceptions=False) as browser:
        response = browser.post('/api/ai/chat/stream', json=request_body())
    assert_refused(response, '/api/ai/chat/stream')
    assert calls == [] and no_answer_saved()


@pytest.mark.parametrize('path', PATHS)
def test_revoked_bearer_never_saves_or_returns_image_answer(path, app, monkeypatch):
    active = True
    credential = 'synthetic-reviewed-image-credential'
    # Exercise real route/middleware Bearer handling while the credential store
    # is a bounded synthetic lookup. The common auth suite covers its encryption.
    monkeypatch.setattr(companion_auth, 'credential_owner', lambda value: 'local' if active and value == credential else None)
    calls = []
    def post(*args, **kwargs):
        nonlocal active
        calls.append('send')
        active = False
        return SimpleNamespace(status_code=200, raise_for_status=lambda: None,
            json=lambda: {'choices': [{'message': {'content': 'Synthetic image answer.'}}]})
    monkeypatch.setattr(chat.requests, 'post', post)
    with TestClient(app, base_url='https://screenshot.invalid', raise_server_exceptions=False) as phone:
        response = phone.post(path, json=request_body(), headers={'Authorization': 'Bearer ' + credential})
    assert_refused(response, path)
    assert calls == ['send'] and no_answer_saved()


@pytest.mark.parametrize('path', PATHS)
@pytest.mark.parametrize('phase', ['image_return', 'saved_turn_return'])
def test_route_rechecks_before_save_and_response(path, phase, app, monkeypatch):
    monkeypatch.setattr(S, '_active_sessions', {})
    token = S.create_session_token('local')
    if phase == 'image_return':
        def returned_image(*args, **kwargs):
            # A callback-aware worker normally checks itself; this forced
            # boundary independently proves the caller's publication check.
            S.revoke_session_token(token)
            return {'reply': 'Synthetic completed image answer.', 'provider': 'lmstudio', 'model': 'fixture',
                    'host': {'id': 'host', 'name': 'Office'}, 'context_categories': [], 'retained_image': None}
        monkeypatch.setattr(chat_routes if path == '/chat' else ai_routes, 'image_reply', returned_image)
    else:
        monkeypatch.setattr(chat.requests, 'post', lambda *a, **k: SimpleNamespace(status_code=200,
            raise_for_status=lambda: None, json=lambda: {'choices': [{'message': {'content': 'Synthetic completed image answer.'}}]}))
        if path == '/chat':
            original = chat_routes._save_chat_turn
            def saved(*args, **kwargs):
                result = original(*args, **kwargs)
                S.revoke_session_token(token)
                return result
            monkeypatch.setattr(chat_routes, '_save_chat_turn', saved)
        else:
            original = ai_routes._save_turn
            def saved(ident, role, *args, **kwargs):
                result = original(ident, role, *args, **kwargs)
                if role == 'assistant': S.revoke_session_token(token)
                return result
            monkeypatch.setattr(ai_routes, '_save_turn', saved)
    with TestClient(app, base_url='https://screenshot.invalid', cookies={'tli_session': token}, raise_server_exceptions=False) as browser:
        response = browser.post(path, json=request_body())
    assert_refused(response, path)
    assert no_answer_saved() is (phase == 'image_return')
    # A transaction completed before revocation is preserved, not silently
    # rewritten to imply atomic cancellation; its later reply is suppressed.


@pytest.mark.parametrize('path', PATHS)
def test_guided_question_is_rejected_whole_instead_of_losing_suffix(path, client, monkeypatch):
    calls = []
    monkeypatch.setattr(models, 'image_provider', lambda: calls.append('provider') or dict(PROVIDER))
    monkeypatch.setattr(vision, 'retain', lambda *a, **k: calls.append('retain'))
    monkeypatch.setattr(chat.requests, 'post', lambda *a, **k: calls.append('send') or SimpleNamespace(
        status_code=200, raise_for_status=lambda: None,
        json=lambda: {'choices': [{'message': {'content': 'Synthetic image answer.'}}]}))
    response = client.post(path, json=request_body(message='x' * 12000 + ' Important final question.', retention_days=1))
    if path.endswith('/stream'):
        frames = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
        assert [frame['type'] for frame in frames] == ['error']
        assert 'shorten' in frames[0]['detail'].lower()
    else:
        assert response.status_code == 422, response.text
        assert 'shorten' in response.json()['detail'].lower()
    assert calls == [] and no_answer_saved()


def test_guided_question_at_boundary_is_sent_without_text_loss(monkeypatch):
    sent = []
    def post(*args, **kwargs):
        sent.append(kwargs['json']['messages'][-1]['content'][0]['text'])
        return SimpleNamespace(status_code=200, raise_for_status=lambda: None,
            json=lambda: {'choices': [{'message': {'content': 'Synthetic image answer.'}}]})
    monkeypatch.setattr(chat.requests, 'post', post)
    text = 'x' * 11984 + ' Final question.'
    assert len(text) == 12000
    from intelligence.screenshots import ScreenshotOptions
    body = request_body(message=text)
    chat.image_reply('local', text, body['image_b64'], screenshot=ScreenshotOptions(**body['screenshot']))
    assert sent == [text]


@pytest.mark.parametrize('path', PATHS)
def test_contended_retention_lock_revocation_preserves_encrypted_store(path, app, monkeypatch):
    monkeypatch.setattr(S, '_active_sessions', {})
    token = S.create_session_token('local')
    previous = [{'id': 'kept', 'expires_at': time.time() + 3600, 'b64': 'synthetic-kept', 'mime': 'image/jpeg'},
                {'id': 'expired', 'expires_at': time.time() - 3600, 'b64': 'synthetic-expired', 'mime': 'image/jpeg'}]
    store.write_private('local', 'images', previous)
    saved_path = store.private_path('local', 'images', create=False)
    before = saved_path.read_bytes(), saved_path.stat().st_mtime_ns
    entered, held, contending = Event(), Event(), Event()
    actual_lock, original_retain, original_write = store.LOCK, vision.retain, vision.write_private
    writes, sends = [], []
    def waiting_retain(*args, **kwargs):
        entered.set()
        assert held.wait(5), 'The test must acquire the real lock before retention.'
        return original_retain(*args, **kwargs)
    class ObserveAcquisition:
        def __enter__(self):
            contending.set()
            actual_lock.acquire()
            return self
        def __exit__(self, *_):
            actual_lock.release()
    def write(*args, **kwargs):
        writes.append(args[1])
        return original_write(*args, **kwargs)
    monkeypatch.setattr(vision, 'retain', waiting_retain)
    monkeypatch.setattr(vision, 'LOCK', ObserveAcquisition())
    monkeypatch.setattr(vision, 'write_private', write)
    monkeypatch.setattr(chat.requests, 'post', lambda *a, **k: sends.append('sent') or pytest.fail('Revoked retention must not dispatch the image'))
    with TestClient(app, base_url='https://screenshot.invalid', cookies={'tli_session': token}, raise_server_exceptions=False) as browser:
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(browser.post, path, json=request_body(retention_days=1))
            assert entered.wait(5), 'Image preparation must reach retention before the lock is held.'
            with actual_lock:
                held.set()
                assert contending.wait(5), 'The request must be genuinely queued on the held RLock.'
                S.revoke_session_token(token)
            response = future.result(timeout=5)
    assert_refused(response, path)
    assert writes == [] and sends == []
    assert (saved_path.read_bytes(), saved_path.stat().st_mtime_ns) == before
    assert store.read_private('local', 'images', []) == previous
