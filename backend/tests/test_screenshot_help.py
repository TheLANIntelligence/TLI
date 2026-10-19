import base64
import io
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from PIL import Image
import tli_state as S
from ai import ai_routes
from intelligence import chat, devices, diagnostics, memory, models, screenshots, vision
from intelligence.store import write_private
from routers import home_power


PROVIDER = {"provider": "lmstudio", "model": "fixture-vision", "url": "http://192.0.2.8:1234/v1/chat/completions"}
PATHS = ['/api/ai/chat', '/api/ai/chat/stream', '/chat']


def encoded_image():
    out = io.BytesIO()
    Image.new('RGB', (32, 32), 'blue').save(out, 'PNG')
    return base64.b64encode(out.getvalue()).decode()


def options(**kw):
    return {"task": "explain", "provider_key": screenshots.provider_details(PROVIDER)['key'], **kw}


def request_body(**kw):
    return {"message": "Help with this screen", "image_b64": encoded_image(), "screenshot": options(), **kw}


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(S, 'DATA_DIR', str(tmp_path))
    monkeypatch.setattr(S, 'CONVERSATIONS_FILE', str(tmp_path / 'conversations.json'))
    monkeypatch.setattr(S, 'load_node_config', lambda: SimpleNamespace(node_id='host', node_name='Office', role='standalone'))
    monkeypatch.setattr(S, 'load_shelly_registry', lambda: [])
    monkeypatch.setattr(S, 'load_mesh_directory', lambda: {'peer': {'node_name': 'Work laptop', 'ip': '192.0.2.10'}})
    monkeypatch.setattr(home_power, 'get_runtime', lambda: SimpleNamespace(load_devices=lambda: []))
    monkeypatch.setattr(S, 'load_pin_config', lambda: {'enabled': False})
    monkeypatch.setattr(models, 'image_provider', lambda: dict(PROVIDER))
    monkeypatch.setattr(ai_routes, '_route_action_intent', lambda *a: pytest.fail('Screenshot must never run an action'))
    monkeypatch.setattr(ai_routes, '_find_mesh_ai_peer', lambda: pytest.fail('No image mesh fallback'))
    monkeypatch.setattr(diagnostics, 'run', lambda *a, **kw: pytest.fail('No automatic diagnostics'))


@pytest.fixture
def provider_calls(monkeypatch):
    calls = []
    def post(url, **kw):
        calls.append((url, kw))
        return SimpleNamespace(status_code=200, raise_for_status=lambda: None,
            json=lambda: {'choices': [{'message': {'content': 'The screen shows an error. Read its code before continuing.'}}]})
    monkeypatch.setattr(chat.requests, 'post', post)
    return calls


def saved_report(user='local', **kw):
    report = {'id': 'report-1', 'host': devices.node(), 'target': None, 'kind': 'system',
              'created_at': '2025-01-01T00:00:00Z', 'checks': [{'status': 'pass', 'detail': 'RAM was 30%'}],
              'scope': 'Only the Office host was checked.', 'verified_fix': None, **kw}
    write_private(user, 'diagnostics', [report])
    return report


def test_review_is_read_only_and_uses_registered_computers(client, provider_calls):
    response = client.get('/api/intelligence/screenshots/context')
    assert response.status_code == 200
    body = response.json()
    assert [c['id'] for c in body['computers']] == ['node-host', 'node-peer']
    assert body['provider']['destination'] == '192.0.2.8'
    assert 'advertises' in body['provider']['note']
    assert 'url' not in body['provider'] and body['checked_at']
    assert response.headers['cache-control'] == 'no-store'
    assert not provider_calls


@pytest.mark.parametrize('path', PATHS)
def test_success_uses_guidance_no_actions_or_implicit_memory(path, client, monkeypatch, provider_calls):
    monkeypatch.setattr(memory, 'relevant', lambda *a: pytest.fail('Screenshot did not request memories'))
    body = request_body(message='turn off lamp', device_id='this-is-only-the-phone',
                        target_id='a-stale-printer-selection', screenshot=options(target_id='node-peer', task='next_step'))
    response = client.post(path, json=body)
    assert response.status_code == 200
    if path.endswith('/stream'):
        frames = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
        assert [f['type'] for f in frames] == ['meta', 'delta', 'done']
        result = frames[0]
    else:
        result = response.json()
    assert result['screenshot_context']['computer']['node_id'] == 'peer'
    assert result['screenshot_context']['actions_performed'] is False
    assert len(provider_calls) == 1
    payload = provider_calls[0][1]['json']
    assert provider_calls[0][1]['allow_redirects'] is False
    instructions = payload['messages'][0]['content']
    assert 'one next step' in instructions and 'not a live view' in instructions
    assert 'untrusted reference data' in instructions
    assert 'this-is-only-the-phone' not in instructions and 'a-stale-printer' not in instructions
    assert 'memory' not in json.loads(instructions.split('Reference data:\n')[1])
    assert not payload.get('tools')
    assert encoded_image() not in json.dumps(S.load_conversations())
    assert not vision.images('local')


@pytest.mark.parametrize('target', [None, 'node-peer'])
def test_host_report_cannot_become_another_computers_health(target, client, provider_calls):
    saved_report()
    response = client.post('/api/ai/chat', json=request_body(diagnostic_id='report-1', screenshot=options(target_id=target)))
    assert response.status_code == 409
    assert 'does not measure' in response.json()['detail']
    assert not provider_calls


def test_matching_report_keeps_timestamp_scope_and_no_live_health(client, provider_calls):
    saved_report()
    response = client.post('/api/ai/chat', json=request_body(diagnostic_id='report-1', screenshot=options(target_id='node-host')))
    assert response.status_code == 200
    text = provider_calls[0][1]['json']['messages'][0]['content']
    assert '2025-01-01' in text and 'Only the Office host' in text and 'never prove current health' in text
    assert response.json()['screenshot_context']['report_id'] == 'report-1'


def test_peer_reachability_is_not_peer_resource_evidence(client, provider_calls):
    saved_report(target={'id': 'node-peer'}, kind='device')
    response = client.post('/api/ai/chat', json=request_body(diagnostic_id='report-1', screenshot=options(target_id='node-host')))
    assert response.status_code == 409 and not provider_calls


def test_report_ownership_checked_before_model(client, provider_calls):
    saved_report('someone-else')
    response = client.post('/api/ai/chat', json=request_body(diagnostic_id='report-1', screenshot=options(target_id='node-host')))
    assert response.status_code == 404 and not provider_calls


@pytest.mark.parametrize('extra', [{}, {'other_computer': 'My work PC'}])
def test_unknown_and_unregistered_computer_have_no_inferred_host_metrics(extra):
    result = screenshots.evidence('local', screenshots.ScreenshotOptions(**options(**extra)))
    reference = json.loads(result['text'].split('Reference data:\n')[1])
    assert set(reference) == {'screenshot'}
    assert reference['screenshot']['computer']['node_id'] is None
    assert result['screenshot_context']['computer']['name'] == extra.get('other_computer', 'Unknown computer')


@pytest.mark.parametrize('path', PATHS)
def test_missing_image_never_falls_through_to_actions(path, client, provider_calls):
    response = client.post(path, json=request_body(image_b64=None, message='turn off lamp'))
    assert response.status_code == 422 and not provider_calls


@pytest.mark.parametrize('patch', [dict(task='execute'), dict(provider_key='bad'), dict(extra='injected'),
                                 dict(target_id='node-host', other_computer='Other')])
def test_invalid_guidance_is_rejected_before_provider(patch, client, provider_calls):
    response = client.post('/api/ai/chat', json=request_body(screenshot=options(**patch)))
    assert response.status_code == 422 and not provider_calls


def test_unknown_or_noncomputer_target_never_sends(client, monkeypatch, provider_calls):
    assert client.post('/api/ai/chat', json=request_body(screenshot=options(target_id='missing'))).status_code == 404
    monkeypatch.setattr(devices, 'get', lambda ident: {'id': ident, 'kind': 'printer'})
    assert client.post('/api/ai/chat', json=request_body(screenshot=options(target_id='printer'))).status_code == 422
    assert not provider_calls


def test_changed_provider_rejected_before_retention_and_send(client, monkeypatch, provider_calls):
    monkeypatch.setattr(models, 'image_provider', lambda: {**PROVIDER, 'url': 'http://192.0.2.9/v1/chat/completions'})
    response = client.post('/api/ai/chat', json=request_body(retention_days=1))
    assert response.status_code == 409 and 'provider changed' in response.json()['detail']
    assert not provider_calls and not vision.images('local')


@pytest.mark.parametrize('path', PATHS)
def test_generic_image_keeps_reviewed_destination_without_screenshot_mode(path, client, provider_calls):
    body = request_body(screenshot=None, image_provider_key='b' * 64)
    response = client.post(path, json=body)
    if path.endswith('/stream'):
        assert '"type": "error"' in response.text and '"type": "done"' not in response.text
    else:
        assert response.status_code == 409
    assert 'provider changed' in response.text and not provider_calls
    body['image_provider_key'] = options()['provider_key']
    assert client.post(path, json=body).status_code == 200
    assert len(provider_calls) == 1


def test_bundled_review_key_includes_selection_and_hides_credentials():
    one = screenshots.provider_details({**PROVIDER, 'selection': 'vision', 'url': 'https://secret:password@example.test/v1/chat'})
    two = screenshots.provider_details({**PROVIDER, 'selection': 'other-vision', 'url': 'https://secret:password@example.test/v1/chat'})
    assert one['key'] != two['key']
    assert 'secret' not in json.dumps(one) and 'password' not in json.dumps(one)


def test_bundled_change_between_discovery_and_generation_never_sends(monkeypatch, provider_calls):
    provider = {**PROVIDER, 'provider': 'bundled', 'selection': 'vision'}
    monkeypatch.setattr(models, 'image_provider', lambda: provider)
    with pytest.raises(HTTPException) as exc:
        chat.image_reply('local', 'image', encoded_image(), screenshot=screenshots.ScreenshotOptions(
            provider_key=screenshots.provider_details(provider)['key']))
    assert exc.value.status_code == 409 and not provider_calls


def test_unavailable_provider_does_not_send_or_fall_back(client, monkeypatch, provider_calls):
    def unavailable():
        raise HTTPException(409, 'No available image-capable model. The image was not sent.')
    monkeypatch.setattr(models, 'image_provider', unavailable)
    assert client.get('/api/intelligence/screenshots/context').json()['provider'] is None
    response = client.post('/api/ai/chat/stream', json=request_body())
    assert '"type": "error"' in response.text and '"type": "done"' not in response.text
    assert not provider_calls


@pytest.mark.parametrize('failure', ['timeout', 'redirect', 'empty'])
def test_provider_failure_no_retry_or_success(client, monkeypatch, failure):
    calls = []
    def post(*a, **kw):
        calls.append(kw)
        if failure == 'timeout':
            raise TimeoutError('fake timeout')
        return SimpleNamespace(status_code=302 if failure == 'redirect' else 200, raise_for_status=lambda: None,
            json=lambda: {'choices': [{'message': {'content': ''}}]})
    monkeypatch.setattr(chat.requests, 'post', post)
    response = client.post('/api/ai/chat/stream', json=request_body())
    assert '"type": "error"' in response.text and '"type": "done"' not in response.text
    assert len(calls) == 1


def test_corrupt_screenshot_rejected_before_discovery(client, monkeypatch, provider_calls):
    monkeypatch.setattr(models, 'image_provider', lambda: pytest.fail('Invalid image must fail first'))
    assert client.post('/api/ai/chat', json=request_body(image_b64='invalid')).status_code == 422
    assert not provider_calls


def test_auth_required_before_sharing_context_or_images(client, monkeypatch, provider_calls):
    monkeypatch.setattr(S, 'load_pin_config', lambda: {'enabled': True})
    assert client.get('/api/intelligence/screenshots/context').status_code == 401
    for path in PATHS:
        assert client.post(path, json=request_body()).status_code == 401
    assert not provider_calls


def test_duplicate_screenshot_turn_cannot_start_another_provider_call(client, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    entered, finish = Event(), Event()
    calls = []
    def post(*a, **kw):
        calls.append(kw)
        entered.set()
        assert finish.wait(5)
        return SimpleNamespace(status_code=200, raise_for_status=lambda: None,
            json=lambda: {'choices': [{'message': {'content': 'Visible evidence only.'}}]})
    monkeypatch.setattr(chat.requests, 'post', post)
    payload = request_body(conversation_id='same-screenshot-turn')
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(client.post, '/api/ai/chat/stream', json=payload)
        try:
            assert entered.wait(5)
            assert client.post('/api/ai/chat', json=payload).status_code == 409
            assert client.post('/chat', json=payload).status_code == 409
            assert len(calls) == 1
        finally:
            finish.set()
        assert '"type": "done"' in first.result(timeout=5).text


@pytest.mark.parametrize('path', PATHS)
def test_phone_screenshot_receipt_reopens_on_desktop_for_same_owner(path, app, monkeypatch, provider_calls):
    from fastapi.testclient import TestClient
    from pathlib import Path
    import companion_auth as auth
    import node_identity
    import data_protection

    origin = 'https://192.168.1.20:8000'
    monkeypatch.setattr(S, 'TLS_ENABLED', True)
    monkeypatch.setattr(S, 'PIN_CONFIG_FILE', Path(S.DATA_DIR) / 'tli_pin.json')
    monkeypatch.setattr(S, 'NODE_CONFIG_PATH', Path(S.DATA_DIR) / 'mesh' / 'node_config.json')
    S.save_pin_config('a' * 64, 'b' * 64)
    S.save_node_config(S.NodeConfig(node_id='host', node_name='Office', role='standalone',
                                   created_at='2025-01-01T00:00:00Z', updated_at='2025-01-01T00:00:00Z'))
    monkeypatch.setattr(data_protection, 'is_windows', lambda: False)
    monkeypatch.setattr(node_identity, '_ident', None)
    monkeypatch.setattr(node_identity, '_data_dir', S.DATA_DIR)
    node_identity.init(S.DATA_DIR)
    monkeypatch.setattr(S, 'load_pin_config', lambda: {'enabled': True})
    monkeypatch.setattr(S, '_active_sessions', {})
    token, _ = auth.create_pairing('alice', origin, 'f' * 64)
    phone = auth.redeem_pairing(token, origin, 'f' * 64, 'Test phone', 'ios')
    saved_report('alice')
    body = request_body(conversation_id='shared-screenshot', diagnostic_id='report-1',
                        screenshot=options(target_id='node-host', task='error'))
    with TestClient(app, base_url=origin) as client:
        response = client.post(path, json=body, headers={'Authorization': 'Bearer ' + phone['credential']})
        assert response.status_code == 200
        if path.endswith('/stream'):
            assert '"type": "done"' in response.text
        headers = {'Cookie': 'tli_session=' + S.create_session_token('alice')}
        for read_path in ['/api/ai/conversations/shared-screenshot', '/conversations/shared-screenshot']:
            reopened = client.get(read_path, headers=headers)
            assert reopened.status_code == 200
            messages = reopened.json()['messages']
            receipt = messages[-1]['screenshot_context']
            assert receipt == {'task': 'error', 'computer': {'id': 'node-host', 'name': 'Office',
                               'node_id': 'host', 'source': 'local_node'}, 'report_id': 'report-1',
                               'capture': 'user_shared_snapshot', 'actions_performed': False}
            assert 'screenshot_context' not in messages[0]
        foreign = {'Cookie': 'tli_session=' + S.create_session_token('bob')}
        assert client.get('/api/ai/conversations/shared-screenshot', headers=foreign).status_code == 404
        assert client.get('/conversations/shared-screenshot', headers=foreign).status_code == 403
    persisted = json.dumps(S.load_conversations())
    assert encoded_image() not in persisted and options()['provider_key'] not in persisted
    assert 'image_b64' not in persisted and 'provider_key' not in persisted
    assert len(provider_calls) == 1


def test_receipt_persistence_projects_only_bounded_display_fields():
    from routers import chat_routes

    receipt = screenshots.evidence('local', screenshots.ScreenshotOptions(**options()))['screenshot_context']
    injected = {**receipt, 'image_b64': 'private-image', 'provider_key': 'private-key',
                'computer': {**receipt['computer'], 'image_url': 'private-url'}}
    identifier = ai_routes._get_or_create_conv('receipt-projection', user_id='local')
    ai_routes._save_turn(identifier, 'assistant', 'First answer', screenshot_context=injected)
    chat_routes._save_chat_turn(chat_routes.ChatRequest(message='Follow up', user_id='local',
                               conversation_id=identifier), 'Second answer', 'fixture', screenshot_context=injected)
    turns = S.load_conversations()[identifier]['messages']
    assert turns[0]['screenshot_context'] == receipt
    assert turns[-1]['screenshot_context'] == receipt
    assert 'private-' not in json.dumps(turns)


@pytest.mark.parametrize('patch', [dict(task='repair'), dict(actions_performed=True),
                                 dict(computer={'name': 'x' * 257}), dict(report_id='x' * 257),
                                 dict(computer={'name': 'PC', 'source': ['invalid']})])
def test_invalid_optional_receipt_does_not_break_legacy_history(patch, local_browser_client):
    client = local_browser_client
    receipt = screenshots.evidence('local', screenshots.ScreenshotOptions(**options()))['screenshot_context']
    S.save_conversations({'legacy': {'id': 'legacy', 'user_id': 'local', 'messages': [
        {'role': 'user', 'content': 'Old question'},
        {'role': 'assistant', 'content': 'Old answer'},
        {'role': 'assistant', 'content': 'Answer with malformed metadata', 'screenshot_context': {**receipt, **patch}},
    ]}})
    response = client.get('/api/ai/conversations/legacy')
    assert response.status_code == 200
    from intelligence.chat_memory import source_ref
    expected = [
        {'role': 'user', 'content': 'Old question'}, {'role': 'assistant', 'content': 'Old answer'},
        {'role': 'assistant', 'content': 'Answer with malformed metadata'},
    ]
    assert response.json()['messages'] == [
        {**turn, 'source_ref': source_ref('legacy', index, turn)} for index, turn in enumerate(expected)
    ]
    assert screenshots.public_receipt({**receipt, **patch}) is None
