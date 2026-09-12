"""Reviewed chat copies use synthetic encrypted stores and no providers."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import tli_state as S
from intelligence import chat_memory as C, memory
from routers import memory_tools_routes
from routers.system_routes import require_session

OWNER = 'fixture-owner'


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(S, 'DATA_DIR', str(tmp_path))
    monkeypatch.setattr(S, 'CONVERSATIONS_FILE', str(tmp_path / 'conversations.json'))
    monkeypatch.setattr(C.devices, 'get', lambda ident: {'id': ident} if ident == 'host' else (_ for _ in ()).throw(HTTPException(404, 'Device unavailable')))
    from ai.ai_manager import BundledAIManager
    monkeypatch.setattr(BundledAIManager, 'get', lambda: pytest.fail('No inference for saving chat'))
    monkeypatch.setattr(S.lm_provider, 'complete', lambda **kw: pytest.fail('No provider'))


@pytest.fixture
def api():
    app = FastAPI(); app.include_router(memory_tools_routes.router)
    app.dependency_overrides[require_session] = lambda: OWNER
    with TestClient(app) as client:
        yield client


def conversation(role='assistant', text='Try restarting the printer.', owner=OWNER):
    turns = [{'role': 'user', 'content': 'What might help?', 'ts': '2026-09-01T11:00:00Z'},
             {'role': role, 'content': text, 'ts': '2026-09-01T11:01:00Z', 'provider': 'bundled', 'model': 'fixture'}]
    S.save_conversations({'conv-one': {'id': 'conv-one', 'user_id': owner, 'messages': turns}})
    return C.source_ref('conv-one', 1, turns[1])


def payload(ref, **extra):
    return {'source_ref': ref, 'text': 'Printer suggestion to review.', 'title': 'Printer', 'reviewed': True, **extra}


def test_preview_auth_and_protocol_do_not_run_inference(api):
    response = api.get('/api/intelligence/memory/capabilities')
    assert response.json() == {'ok': True, 'protocol': C.PROTOCOL,
                               'use_conversation_history': True, 'evidence_context_version': 1}
    assert response.headers['cache-control'] == 'no-store'
    ref = conversation()
    response = api.post('/api/intelligence/memory/from-chat/preview', json={'source_ref': ref})
    data = response.json()
    assert data['source_kind'] == 'ai_suggestion' and data['source']['role'] == 'assistant'
    assert data['source']['created_at'] == '2026-09-01T11:01:00Z'
    assert data['suggested_text'] == data['text']
    assert not S.load_memory(OWNER, strict=True)['facts']
    def denied(): raise HTTPException(401, 'Locked')
    api.app.dependency_overrides[require_session] = denied
    for path in ('capabilities', 'from-chat/preview', 'from-chat/save'):
        response = api.get('/api/intelligence/memory/' + path) if path == 'capabilities' else api.post('/api/intelligence/memory/' + path, json=payload(ref))
        assert response.status_code == 401


@pytest.mark.parametrize('role,source', [('user', 'chat_user'), ('assistant', 'chat_ai')])
def test_save_preserves_origin_after_encrypted_roundtrip_and_never_confirms_fix(api, role, source):
    ref = conversation(role)
    response = api.post('/api/intelligence/memory/from-chat/save', json=payload(ref, category='device', device_id='host'))
    assert response.status_code == 200
    fact = S.load_memory(OWNER, strict=True)['facts'][0]
    assert fact['source'] == source and fact['category'] == 'device'
    assert fact['chat_source'] == {**ref, 'role': role, 'created_at': '2026-09-01T11:01:00Z', 'provider': 'bundled', 'model': 'fixture'}
    assert not fact.get('report_id') and 'verified_fix' not in json.dumps(fact)
    assert 'content' not in fact['chat_source'] and 'text' not in fact['chat_source']
    assert fact['created_at'] != fact['chat_source']['created_at']
    assert response.json()['note']['revision'] == memory.public_fact(fact)['revision']


@pytest.mark.parametrize('mutation,code', [('owner', 404), ('delete', 404), ('text', 409), ('date', 409), ('role', 409)])
def test_changed_deleted_and_cross_owner_sources_never_write(api, mutation, code):
    ref = conversation()
    records = S.load_conversations()
    if mutation == 'owner': records['conv-one']['user_id'] = 'other'
    elif mutation == 'delete': records.clear()
    else: records['conv-one']['messages'][1][{'text': 'content', 'date': 'ts', 'role': 'role'}[mutation]] = 'user' if mutation == 'role' else 'changed'
    S.save_conversations(records)
    assert api.post('/api/intelligence/memory/from-chat/save', json=payload(ref)).status_code == code
    assert not S.load_memory(OWNER, strict=True)['facts']


@pytest.mark.parametrize('extra', [{'reviewed': False}, {'reviewed': 1}, {'source': 'user_confirmation'}, {'category': 'verified_fix'}, {'text': ' '}, {'text': 'x' * 2001}, {'device_id': 'missing'}])
def test_unreviewed_spoofed_invalid_notes_rejected(api, extra):
    ref = conversation()
    assert api.post('/api/intelligence/memory/from-chat/save', json=payload(ref, **extra)).status_code in (422, 404)
    assert not S.load_memory(OWNER, strict=True)['facts']


@pytest.mark.parametrize('index', [-1, True, '1', 1.0, 1000001])
def test_strict_index(api, index):
    ref = conversation(); ref['message_index'] = index
    assert api.post('/api/intelligence/memory/from-chat/save', json=payload(ref)).status_code == 422


def test_long_source_requires_explicit_excerpt(api):
    ref = conversation(text='x' * 2001)
    preview = api.post('/api/intelligence/memory/from-chat/preview', json={'source_ref': ref}).json()
    assert preview['requires_excerpt'] is True and preview['suggested_text'] == '' and len(preview['text']) == 2001
    assert api.post('/api/intelligence/memory/from-chat/save', json=payload(ref)).status_code == 200
    assert C.source_ref('conv', 0, {'role': 'assistant', 'content': 'x' * 32001}) is None


def test_duplicate_requests_and_later_edits_not_overwritten():
    ref = conversation()
    with ThreadPoolExecutor(max_workers=6) as pool:
        responses = list(pool.map(lambda _: C.save(OWNER, ref, text='Reviewed copy', title='Printer'), range(6)))
    assert sum(not response['already_saved'] for response in responses) == 1
    assert len(S.load_memory(OWNER, strict=True)['facts']) == 1
    original = responses[0]['note']
    edited = memory.change(OWNER, original['id'], 'My later correction', expected_revision=original['revision'])
    retry = C.save(OWNER, ref, text='Reviewed copy', title='Printer')
    assert retry['already_saved'] is True and retry['note']['text'] == edited['text']
    assert len(S.load_memory(OWNER, strict=True)['facts']) == 1


def test_corrupt_source_store_is_not_overwritten(api):
    ref = conversation()
    path = Path(S.CONVERSATIONS_FILE); path.write_text('{broken', encoding='utf-8')
    assert api.post('/api/intelligence/memory/from-chat/save', json=payload(ref)).status_code == 503
    assert path.read_text() == '{broken' and not S.load_memory(OWNER, strict=True)['facts']


def test_source_refs_latest_pair_stable_when_receipt_added():
    ref = conversation()
    refs = C.source_refs('conv-one', OWNER)
    assert refs['source_ref'] == ref and refs['user_source_ref']['message_index'] == 0
    records = S.load_conversations(); records['conv-one']['messages'][1]['memory_context'] = {'status': 'none'}
    S.save_conversations(records)
    assert C.source_refs('conv-one', OWNER) == refs
    with pytest.raises(HTTPException) as error: C.source_refs('conv-one', 'other')
    assert error.value.status_code == 404


def test_reviewed_update_replaces_one_note_and_preserves_identity(api):
    ref = conversation()
    old = memory.save_fact(OWNER, 'Old printer advice', 'device', 'host',
                           report_id='historical-report', title='Previous fix')
    unrelated = memory.save_fact(OWNER, 'Keep this preference', 'preference')
    result = api.post('/api/intelligence/memory/from-chat/save', json=payload(
        ref, note_id=old['id'], expected_revision=old['revision'],
        text='Reviewed correction', title='Printer correction', category='device', device_id='host'))
    assert result.status_code == 200
    assert result.json()['updated_existing'] is True
    note = result.json()['note']
    assert note['id'] == old['id'] and note['created_at'] == old['created_at']
    assert note['text'] == 'Reviewed correction' and note['source'] == 'chat_ai'
    assert note['device_id'] == 'host' and note['chat_source']['revision'] == ref['revision']
    assert not note.get('report_id') and note['revision'] != old['revision']
    facts = memory.list_facts(OWNER)
    assert len(facts) == 2
    assert next(f for f in facts if f['id'] == unrelated['id']) == unrelated
    assert memory.relevant(OWNER, 'Old printer advice', target_id='host')[0]['text'] == 'Reviewed correction'


@pytest.mark.parametrize('failure', ['no_revision', 'stale', 'deleted', 'other_owner', 'bad_device', 'source_changed'])
def test_rejected_update_preserves_all_saved_records(api, failure):
    ref = conversation()
    old = memory.save_fact('other' if failure == 'other_owner' else OWNER, 'Original text', title='Printer')
    params = dict(note_id=old['id'], expected_revision=old['revision'])
    expected = 409
    if failure == 'no_revision': params.pop('expected_revision')
    if failure == 'stale': memory.change(OWNER, old['id'], 'Another browser correction')
    if failure == 'deleted':
        memory.change(OWNER, old['id'], None)
        expected = 404
    if failure == 'other_owner': expected = 404
    if failure == 'bad_device':
        params['device_id'] = 'missing'
        expected = 404
    if failure == 'source_changed':
        records = S.load_conversations()
        records['conv-one']['messages'][1]['content'] = 'Changed source'
        S.save_conversations(records)
    # Include encrypted files and keys, not just projected JSON, in preservation.
    before = {str(p): p.read_bytes() for p in Path(S.DATA_DIR).rglob('*') if p.is_file()}
    response = api.post('/api/intelligence/memory/from-chat/save', json=payload(ref, **params))
    assert response.status_code == expected
    assert {str(p): p.read_bytes() for p in Path(S.DATA_DIR).rglob('*') if p.is_file()} == before


def test_update_revision_cannot_be_used_to_create_another_note(api):
    ref = conversation()
    old = memory.save_fact(OWNER, 'Original text')
    response = api.post('/api/intelligence/memory/from-chat/save', json=payload(ref, expected_revision=old['revision']))
    assert response.status_code == 422
    assert memory.list_facts(OWNER) == [old]


def test_simultaneous_updates_accept_only_the_reviewed_revision():
    ref = conversation()
    old = memory.save_fact(OWNER, 'Original text')
    def update(index):
        try:
            return C.save(OWNER, ref, text=f'Reviewed correction {index}', note_id=old['id'], expected_revision=old['revision'])
        except HTTPException as exc:
            return exc.status_code
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(update, range(6)))
    successes = [r for r in results if isinstance(r, dict)]
    assert len(successes) == 1 and results.count(409) == 5
    assert memory.list_facts(OWNER) == [successes[0]['note']]


def test_update_requires_authenticated_owner(api):
    ref = conversation()
    old = memory.save_fact(OWNER, 'Original text')
    def denied(): raise HTTPException(401, 'Locked')
    api.app.dependency_overrides[require_session] = denied
    response = api.post('/api/intelligence/memory/from-chat/save', json=payload(ref, note_id=old['id'], expected_revision=old['revision']))
    assert response.status_code == 401
    assert memory.list_facts(OWNER) == [old]


def test_update_preserves_reviewed_custom_category_and_removed_computer(api):
    ref = conversation()
    old = memory.save_fact(OWNER, 'Old custom setup', 'profile', 'removed-computer')
    result = api.post('/api/intelligence/memory/from-chat/save', json=payload(ref,
        note_id=old['id'], expected_revision=old['revision'], category='profile', device_id='removed-computer'))
    assert result.status_code == 200, result.text
    assert result.json()['note']['device_id'] == 'removed-computer'
    assert result.json()['note']['category'] == 'profile'
    assert len(memory.list_facts(OWNER)) == 1


@pytest.mark.parametrize('old_category, proposed', [('profile', 'work'), ('general', 'verified_fix'), ('verified_fix', 'verified_fix')])
def test_update_cannot_assign_custom_or_confirmed_categories(api, old_category, proposed):
    ref = conversation()
    old = memory.save_fact(OWNER, 'Original note', old_category)
    result = api.post('/api/intelligence/memory/from-chat/save', json=payload(ref,
        note_id=old['id'], expected_revision=old['revision'], category=proposed))
    assert result.status_code == 422
    assert memory.list_facts(OWNER) == [old]
