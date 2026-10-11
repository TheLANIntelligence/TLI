"""Notebook behavior using only isolated files and fake providers."""
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
import tli_state as S
from ai import ai_routes
from intelligence import memory, notebook
from routers import chat_routes

PATHS = ['/api/ai/chat', '/api/ai/chat/stream', '/chat']


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(S, 'DATA_DIR', str(tmp_path))
    monkeypatch.setattr(S, 'CONVERSATIONS_FILE', str(tmp_path / 'conversations.json'))
    monkeypatch.setattr(S, 'load_pin_config', lambda: {'enabled': False})
    monkeypatch.setattr(S, 'load_node_config', lambda: SimpleNamespace(node_id='host', node_name='Office', role='standalone', host_address=None))
    monkeypatch.setattr(ai_routes, '_route_action_intent', lambda *a: pytest.fail('No note actions'))
    monkeypatch.setattr(ai_routes, '_tool_answer', lambda *a: pytest.fail('No note tools'))
    monkeypatch.setattr(ai_routes, 'diagnostic_answer', lambda *a: pytest.fail('No note diagnostics'))
    monkeypatch.setattr(chat_routes, 'diagnostic_answer', lambda *a: pytest.fail('No note diagnostics'))
    monkeypatch.setattr(ai_routes, '_find_mesh_ai_peer', lambda: pytest.fail('No private note mesh forwarding'))
    monkeypatch.setattr(chat_routes, 'proxy_chat_to_host', lambda *a: pytest.fail('No note proxy'))
    monkeypatch.setattr(memory, 'relevant', lambda *a: pytest.fail('No implicit notes'))


@pytest.fixture
def provider(monkeypatch):
    calls = []
    manager = SimpleNamespace(ensure_running=lambda: True, active_preset_id='standard', base_url='http://127.0.0.1:19999')
    monkeypatch.setattr(ai_routes.BundledAIManager, 'get', lambda: manager)
    def complete(base, payload, **kw):
        calls.append(payload)
        return {'model': 'standard', 'choices': [{'message': {'content': 'Your saved note says the spare drive is in the drawer.'}}]}
    def stream(url, payload, **kwargs):
        assert kwargs.get('allow_redirects') is False
        calls.append(payload)
        yield json.dumps({'choices': [{'delta': {'content': 'Your saved note says the spare drive is in the drawer.'}}]})
    monkeypatch.setattr(ai_routes, '_llama_post', complete)
    monkeypatch.setattr(ai_routes, '_llama_stream_raw', stream)
    monkeypatch.setattr(S.lm_provider, 'health_check', lambda: True)
    monkeypatch.setattr(S.lm_provider, 'complete', lambda **kw: calls.append(kw) or {'text': 'The selected note says drawer.', 'model': 'fixture-lm'})
    return calls, manager


def fact(user='local', **kw):
    return memory.save_fact(user, 'The spare drive is in the drawer.', title='Spare drive', **kw)


def body(saved=None, **kw):
    selected = saved or fact()
    return {'message': 'Where is the spare drive?', 'note_refs': [{'id': selected['id'], 'revision': selected['revision']}], **kw}


def result(response, path):
    if path.endswith('/stream'):
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
        merged = {}
        for event in events:
            if event['type'] == 'meta':
                merged.update(event)
        assert events[-1]['type'] == 'done', events
        return merged
    return response.json()


def test_notebook_metadata_roundtrip_and_stale_edits(client):
    saved = client.post('/api/intelligence/memory', json={'text': 'Use A4 paper', 'title': 'Printer paper', 'category': 'device'}).json()
    assert len(saved['revision']) == 64
    assert client.get('/api/intelligence/memory').json()['facts'][0]['title'] == 'Printer paper'
    updated = client.patch('/api/intelligence/memory/' + saved['id'], json={'text': 'Use Letter paper', 'title': 'Paper size', 'category': 'verified_fix', 'device_id': None, 'expected_revision': saved['revision']})
    assert updated.status_code == 200
    changed = updated.json()
    assert changed['revision'] != saved['revision'] and changed['category'] == 'verified_fix'
    assert S.load_memory('local')['facts'][0]['title'] == 'Paper size'
    before = Path(S.memory_path_for_user('local')).read_bytes()
    assert b'Letter paper' not in before
    assert client.patch('/api/intelligence/memory/' + saved['id'], json={'text': 'Stale edit', 'expected_revision': saved['revision']}).status_code == 409
    assert client.delete('/api/intelligence/memory/' + saved['id'], params={'expected_revision': saved['revision']}).status_code == 409
    assert Path(S.memory_path_for_user('local')).read_bytes() == before
    assert client.delete('/api/intelligence/memory/' + saved['id'], params={'expected_revision': changed['revision']}).status_code == 200
    assert client.get('/api/intelligence/memory').json()['facts'] == []


def test_old_edit_clients_preserve_note_metadata(client):
    saved = fact(category='preference')
    changed = client.patch('/api/intelligence/memory/' + saved['id'], json={'text': 'Drawer two'}).json()
    assert changed['title'] == 'Spare drive' and changed['category'] == 'preference'


@pytest.mark.parametrize('raw', [b'broken json', b'[]', b'{"facts":{}}', b'{"facts":[1]}', b'{"_tli_enc":1,"data":"garbage"}', b'{"facts":[{"text":"keep", "id":[]}]}'])
def test_corrupt_store_is_not_empty_or_overwritten(client, raw):
    path = Path(S.memory_path_for_user('local'))
    path.write_bytes(raw)
    assert client.get('/api/intelligence/memory').status_code == 503
    assert client.post('/api/intelligence/memory', json={'text': 'New fact'}).status_code == 503
    assert client.patch('/api/intelligence/memory/old', json={'text': 'Changed'}).status_code == 503
    assert client.delete('/api/intelligence/memory/old').status_code == 503
    assert path.read_bytes() == raw


@pytest.mark.parametrize('raw', [{'facts': ['Older saved fact']}, {'facts': [{'id': 'old', 'text': 'Older saved fact'}]}])
def test_old_formats_and_unknown_dates_have_stable_revisions(client, raw):
    Path(S.memory_path_for_user('local')).write_text(json.dumps(raw))
    first = client.get('/api/intelligence/memory').json()['facts'][0]
    second = client.get('/api/intelligence/memory').json()['facts'][0]
    assert first['revision'] == second['revision'] and first['updated_at'] is None
    req = ai_routes.ChatRequest(**body(first))
    assert notebook.prepare('local', req)['note_context']['notes'][0]['title'] == 'Untitled note'
    changed = client.patch('/api/intelligence/memory/' + first['id'], json={'text': 'Corrected', 'title': 'Saved reference', 'expected_revision': first['revision']})
    assert changed.status_code == 200 and changed.json()['revision'] != first['revision']


@pytest.mark.parametrize('path', PATHS)
def test_note_question_uses_full_selected_reference_and_receipt(path, client, provider):
    calls, _ = provider
    selected = fact()
    response = client.post(path, json=body(selected, message='turn off the lamp', device_id='requesting-phone'))
    assert response.status_code == 200
    data = result(response, path)
    receipt = data['note_context']
    assert receipt['actions_performed'] is False
    assert receipt['notes'][0]['revision'] == selected['revision']
    assert len(calls) == 1
    prompt = json.dumps(calls[0]['messages'])
    assert selected['text'] in prompt and 'untrusted reference data' in prompt
    assert 'requesting-phone' not in prompt and not calls[0].get('tools')
    conversation = S.load_conversations()[data['conversation_id']]
    assert conversation['messages'][-1]['note_context'] == receipt
    history = client.get('/api/ai/conversations/' + data['conversation_id']).json()
    assert history['messages'][-1]['note_context'] == receipt
    assert selected['text'] not in json.dumps(receipt)


def test_explicit_lmstudio_provider_no_automatic_fallback(client, provider):
    calls, _ = provider
    response = client.post('/chat', json=body(brain='lmstudio'))
    assert response.status_code == 200 and response.json()['brain_used'] == 'lmstudio'
    assert len(calls) == 1 and calls[0]['model_id']


@pytest.mark.parametrize('path', PATHS)
@pytest.mark.parametrize('extra', [{'target_id': 'node-host'}, {'diagnostic_id': 'report'}, {'image_b64': 'x'}, {'image_mime': 'image/png'}, {'include_vault_secrets': True}, {'secret_keys': ['private']}])
def test_mixed_context_rejected_before_any_provider(path, extra, client, provider):
    response = client.post(path, json=body(**extra))
    assert response.status_code == 422
    assert not provider[0]


@pytest.mark.parametrize('path', PATHS)
@pytest.mark.parametrize('failure', ['changed', 'deleted', 'foreign', 'oversized', 'duplicate'])
def test_invalid_selection_causes_no_provider_call(path, failure, client, provider):
    saved = fact('bob' if failure == 'foreign' else 'local')
    payload = body(saved)
    expected = 404 if failure in ('deleted', 'foreign') else 409 if failure == 'changed' else 422
    if failure == 'changed':
        memory.change('local', saved['id'], 'Now in the cabinet')
    elif failure == 'deleted':
        memory.change('local', saved['id'], None)
    elif failure == 'oversized':
        payload['message'] = 'x' * 12000
    elif failure == 'duplicate':
        payload['note_refs'] *= 2
    response = client.post(path, json=payload)
    assert response.status_code == expected
    assert not provider[0] and not S.load_conversations()


def test_legacy_device_note_must_be_promoted(client, provider):
    path = memory.legacy_path('notebook-legacy')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('["Legacy note"]')
    saved = client.get('/api/intelligence/memory?client_device_id=notebook-legacy').json()['facts'][0]
    assert client.post('/api/ai/chat', json=body(saved)).status_code == 404
    changed = client.patch('/api/intelligence/memory/' + saved['id'] + '?client_device_id=notebook-legacy', json={'text': 'Legacy note', 'title': 'Imported note', 'category': 'general', 'expected_revision': saved['revision']})
    assert changed.status_code == 200 and changed.json()['id'].startswith('f-')
    assert client.post('/api/ai/chat', json=body(changed.json())).status_code == 200
    assert json.loads(path.read_text()) == []


@pytest.mark.parametrize('path', PATHS)
def test_auth_required_before_notes(path, client, monkeypatch, provider):
    payload = body()
    monkeypatch.setattr(S, 'load_pin_config', lambda: {'enabled': True})
    assert client.post(path, json=payload).status_code == 401
    assert client.get('/api/intelligence/memory').status_code == 401
    assert not provider[0]


def test_unavailable_runtime_never_forwards_to_mesh(client, provider):
    calls, manager = provider
    manager.ensure_running = lambda: False
    response = client.post('/api/ai/chat', json=body())
    assert response.status_code == 409 and 'mesh' in response.json()['detail']
    assert not calls


def test_legacy_mesh_route_rejects_notes(client, monkeypatch, provider):
    monkeypatch.setattr(S, 'load_node_config', lambda: SimpleNamespace(role='member', host_address='192.0.2.9'))
    assert client.post('/chat', json=body()).status_code == 409
    assert not provider[0]


@pytest.mark.parametrize('partial', [False, True])
def test_failed_stream_has_no_success_receipt_or_saved_reply(client, monkeypatch, provider, partial):
    def stream(*a, **kw):
        assert kw.get('allow_redirects') is False
        if partial:
            yield json.dumps({'choices': [{'delta': {'content': 'Partial'}}]})
        yield json.dumps({'type': 'error', 'detail': 'Interrupted'})
    monkeypatch.setattr(ai_routes, '_llama_stream_raw', stream)
    response = client.post('/api/ai/chat/stream', json=body())
    events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
    assert events[-1]['type'] == 'error' and not any('note_context' in e for e in events)
    assert any(e['type'] == 'delta' for e in events) is partial
    assert all(not c['messages'] for c in S.load_conversations().values())


def test_malformed_receipts_never_break_history_or_include_body():
    assert notebook.public_receipt({'notes': 'wrong', 'actions_performed': False}) is None
    good = notebook.prepare('local', ai_routes.ChatRequest(**body()))['note_context']
    good['notes'][0]['text'] = 'Never copy this body into history metadata'
    assert 'text' not in notebook.public_receipt(good)['notes'][0]
    good['actions_performed'] = True
    assert notebook.public_receipt(good) is None


@pytest.mark.parametrize('path', ['/api/ai/chat', '/chat'])
@pytest.mark.parametrize('value', [{}, {'choices': []}, {'choices': [{'message': {'content': {'wrong': 'type'}}}]}])
def test_bad_provider_result_is_failure_without_saved_receipt(path, value, client, monkeypatch, provider):
    calls = []
    monkeypatch.setattr(ai_routes, '_llama_post', lambda *a, **kw: calls.append(a) or value)
    response = client.post(path, json=body())
    assert response.status_code == 502 and len(calls) == 1
    assert all(not c['messages'] for c in S.load_conversations().values())


@pytest.mark.parametrize('path', ['/api/ai/chat', '/chat'])
def test_failed_provider_has_no_automatic_retry(path, client, monkeypatch, provider):
    calls = []
    def fail(*a, **kw):
        calls.append(a)
        raise HTTPException(502, 'Provider failed')
    monkeypatch.setattr(ai_routes, '_llama_post', fail)
    response = client.post(path, json=body())
    assert response.status_code == 502 and len(calls) == 1 and not provider[0]
    assert all(not c['messages'] for c in S.load_conversations().values())


def test_lmstudio_failure_does_not_use_bundled(client, monkeypatch, provider):
    calls = []
    def fail(**kw):
        calls.append(kw)
        raise RuntimeError('provider failed')
    monkeypatch.setattr(S.lm_provider, 'complete', fail)
    response = client.post('/chat', json=body(brain='lmstudio'))
    assert response.status_code == 502 and len(calls) == 1 and not provider[0]
    assert not S.load_conversations()


def test_duplicate_note_question_uses_existing_cross_route_conversation_guard(client, monkeypatch, provider):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    entered, finish = Event(), Event()
    calls = []
    def complete(*a, **kw):
        calls.append(a)
        entered.set()
        assert finish.wait(5)
        return {'choices': [{'message': {'content': 'The drawer.'}}]}
    monkeypatch.setattr(ai_routes, '_llama_post', complete)
    payload = body(conversation_id='shared-notebook-turn')
    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = pool.submit(client.post, '/api/ai/chat', json=payload)
        assert entered.wait(5)
        try:
            duplicate = client.post('/chat', json=payload)
            assert duplicate.status_code == 409 and len(calls) == 1
        finally:
            finish.set()
        assert pending.result(timeout=5).status_code == 200
    assert len(S.load_conversations()['shared-notebook-turn']['messages']) == 2


def test_missing_encryption_key_read_does_not_create_replacement(client, monkeypatch):
    path = Path(S.memory_path_for_user('local'))
    path.write_text('{"_tli_enc":1,"data":"AAAAAAAAAAAAAAAAAAAAAA=="}')
    before = path.read_bytes()
    monkeypatch.setattr(S, '_MEM_KEY', None)
    monkeypatch.setattr(S, '_get_mem_key', lambda: pytest.fail('Do not create a replacement key during read'))
    assert client.get('/api/intelligence/memory').status_code == 503
    assert path.read_bytes() == before
    assert not (Path(S.DATA_DIR) / 'memory_key.bin').exists()


def test_note_refs_are_bounded_and_strict(client, provider):
    saved = fact()
    payload = body(saved)
    payload['note_refs'] *= 5
    assert client.post('/api/ai/chat', json=payload).status_code == 422
    payload['note_refs'] = [{'id': saved['id'], 'revision': saved['revision'], 'text': 'Body cannot be forged'}]
    assert client.post('/api/ai/chat', json=payload).status_code == 422
    assert not provider[0]
