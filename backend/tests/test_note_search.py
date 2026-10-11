"""Optional embedding search over isolated encrypted notes and fake HTTP only."""
import asyncio
import copy
import hashlib
import json
from pathlib import Path
import threading
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException
from starlette.requests import Request

import tli_state as S
from intelligence import memory, note_search as N
from routers import note_search_routes as R


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(S, 'DATA_DIR', str(tmp_path)); monkeypatch.setattr(S, '_active_sessions', {})
    monkeypatch.setattr(S, 'load_pin_config', lambda: {'enabled': False})
    for name in ('_reviews', '_indexes', '_generations'): monkeypatch.setattr(N, name, {})
    for name in ('_building', '_searching'): monkeypatch.setattr(N, name, set())
    monkeypatch.setattr(N, '_slots', threading.BoundedSemaphore(2))
    from ai.ai_manager import BundledAIManager
    monkeypatch.setattr(BundledAIManager, 'get', lambda: pytest.fail('No model lifecycle from optional search'))
    return tmp_path


def note(text='Try a cable', owner='local', **kw):
    return memory.save_fact(owner, text, title='Saved suggestion', **kw)


def ref(fact): return {'id': fact['id'], 'revision': fact['revision']}


def review(facts, user='local', token=None, **kw):
    return N.review(user, token, [ref(f) for f in facts], kw.get('port', 12345), kw.get('model', 'fixture-embed'), kw.get('api_key', ''))


def build(reviewed, user='local', token=None): return asyncio.run(N.build(user, token, reviewed['review_id']))


def search(index, query='cable', user='local', token=None, target=None): return asyncio.run(N.search(user, token, index['index_id'], query, target))


def fingerprint(directory):
    return {str(p.relative_to(directory)): hashlib.sha256(p.read_bytes()).hexdigest() for p in directory.rglob('*') if p.is_file()}


@pytest.fixture
def http(monkeypatch):
    state = SimpleNamespace(requests=[], options=[], status=200, before_client=None, before_chunk=None, payload=None)
    def payload(texts):
        return {'model': 'fixture-embed', 'data': [
            {'index': i, 'embedding': [1, 0, 0] if value == N.PROBE else [0, 1, 0] if 'cable' in value.lower() else [0, 0, 1]}
            for i, value in enumerate(texts)]}
    class Response:
        status_code = 200
        async def __aenter__(self): self.status_code = state.status; return self
        async def __aexit__(self, *args): pass
        async def aiter_bytes(self):
            if state.before_chunk: await state.before_chunk()
            value = state.payload if state.payload is not None else payload(state.requested_texts)
            if isinstance(value, Exception): raise value
            raw = value if isinstance(value, bytes) else json.dumps(value).encode()
            for start in range(0, len(raw), 4096): yield raw[start:start+4096]
    class Client:
        def __init__(self, **kw): state.options.append(kw)
        async def __aenter__(self):
            if state.before_client: await state.before_client()
            return self
        async def __aexit__(self, *args): pass
        def stream(self, method, url, **kw):
            state.requests.append({'method': method, 'url': url, **copy.deepcopy(kw)})
            state.requested_texts = kw['json']['input']; return Response()
    monkeypatch.setattr(N.httpx, 'AsyncClient', Client)
    return state


def test_review_no_inference_and_build_search_keep_sources_and_keys_memory_only(http, isolated):
    first, second = note(), note('Set the paper tray to Letter')
    before = fingerprint(isolated); reviewed = review([first, second], api_key='embed-only-token')
    assert not http.requests and reviewed['inference_called'] is False
    assert reviewed['notes'][0]['text'] == first['text'] and 'embed-only-token' not in str(reviewed)
    index = build(reviewed); result = search(index)
    assert index['note_count'] == 2 and result['results'][0]['id'] == first['id'] and result['results'][0]['similarity'] == 1
    assert result['actions_performed'] is False and result['chat_context_changed'] is False
    assert 'text' not in result['results'][0] and 'vectors' not in index
    assert fingerprint(isolated) == before
    assert 'Try a cable' not in str(N._indexes) and 'paper tray' not in str(N._indexes)
    assert len(N._reviews) == 0 and len(N._indexes) == 1
    for request in http.requests:
        assert request['url'] == 'http://127.0.0.1:12345/v1/embeddings'
        assert request['headers'] == {'Content-Type': 'application/json', 'Authorization': 'Bearer embed-only-token'}
    assert all(o['follow_redirects'] is False and o['trust_env'] is False for o in http.options)


def test_device_scope_requires_exact_reviewed_device_and_keeps_general_candidates(http, monkeypatch):
    general = note(); first = note('Cable for Study', device_id='study'); other = note('Cable for bedroom', device_id='bedroom')
    index = build(review([general, first, other])); assert [r['id'] for r in search(index)['results']] == [general['id']]
    from intelligence import devices
    monkeypatch.setattr(devices, 'get', lambda ident: {'id': ident} if ident == 'study' else (_ for _ in ()).throw(HTTPException(404, 'Missing target')))
    assert {r['id'] for r in search(index, target='study')['results']} == {general['id'], first['id']}
    count = len(http.requests)
    with pytest.raises(HTTPException): search(index, target='missing')
    assert len(http.requests) == count


@pytest.mark.parametrize('failure', ['changed', 'deleted', 'missing_key', 'corrupt'])
def test_invalidated_notes_never_reconstruct_old_contents_or_replace_store(failure, http, isolated):
    fact = note(); index = build(review([fact])); path = Path(S.memory_path_for_user('local'))
    if failure in ('changed', 'deleted'): memory.change('local', fact['id'], 'Changed PRIVATE' if failure == 'changed' else None)
    elif failure == 'missing_key': (isolated/'memory_key.bin').unlink()
    else: path.write_bytes(b'{invalid synthetic source')
    before = fingerprint(isolated); count = len(http.requests)
    with pytest.raises(HTTPException) as error: search(index)
    assert error.value.status_code in (409, 503) and len(http.requests) == count and fingerprint(isolated) == before
    if failure in ('changed', 'deleted'): assert not N._indexes


def test_owner_and_actual_browser_token_must_match_and_never_forward_tli_token(http):
    a = S.create_session_token('alice'); b = S.create_session_token('alice'); other = S.create_session_token('other')
    fact = note(owner='alice'); reviewed = review([fact], 'alice', a)
    for user, token in [('alice', b), ('other', other), ('local', None)]:
        with pytest.raises(HTTPException): build(reviewed, user, token)
    assert not http.requests
    index = build(reviewed, 'alice', a)
    assert a not in str(http.requests) and b not in str(http.requests)
    with pytest.raises(HTTPException): review([fact], 'alice', other)
    S.revoke_session_token(a)
    assert not N._indexes
    with pytest.raises(HTTPException): search(index, user='alice', token=a)


def test_anonymous_review_stops_when_pin_enabled_and_all_revoke_clears_indexes(http, monkeypatch):
    reviewed = review([note()]); monkeypatch.setattr(S, 'load_pin_config', lambda: {'enabled': True})
    with pytest.raises(HTTPException) as error: build(reviewed)
    assert error.value.status_code == 401 and not http.requests
    monkeypatch.setattr(S, 'load_pin_config', lambda: {'enabled': False})
    build(reviewed); S.revoke_all_sessions(); assert not N._indexes and not N._reviews


def test_review_and_index_expiry_fail_before_embedding(http, monkeypatch):
    reviewed = review([note()]); N._reviews[reviewed['review_id']]['expires'] = 0
    with pytest.raises(HTTPException): build(reviewed)
    assert not http.requests
    index = build(review([note('A second note')])); N._indexes[index['index_id']]['expires'] = 0
    with pytest.raises(HTTPException): search(index)
    assert len(http.requests) == 1


def test_previous_index_survives_failed_replacement_and_review_can_be_discarded(http):
    fact = note(); original = build(review([fact])); replacement = review([fact]); http.status = 503
    with pytest.raises(HTTPException): build(replacement)
    assert original['index_id'] in N._indexes and not N._building
    http.status = 200; assert search(original)['results'][0]['id'] == fact['id']
    N.discard('local', None, replacement['review_id']); assert replacement['review_id'] not in N._reviews
    assert original['index_id'] in N._indexes


def test_rebuild_commits_once_and_consumes_review(http):
    fact = note(); old = build(review([fact])); reviewed = review([fact]); fresh = build(reviewed)
    assert old['index_id'] not in N._indexes and fresh['index_id'] in N._indexes
    count = len(http.requests)
    with pytest.raises(HTTPException): build(reviewed)
    assert len(http.requests) == count


@pytest.mark.parametrize('operation', ['save', 'revoke', 'discard'])
def test_change_during_async_client_entry_prevents_private_post(operation, http):
    fact = note(); reviewed = review([fact])
    async def change():
        if operation == 'save': memory.change('local', fact['id'], 'New saved text')
        elif operation == 'revoke': S.revoke_all_sessions()
        else: N.discard('local', None, reviewed['review_id'])
    http.before_client = change
    with pytest.raises(HTTPException): build(reviewed)
    assert not http.requests and not N._indexes and not N._building


def test_lock_during_response_discards_private_index_and_releases_capacity(http):
    async def revoke(): S.revoke_all_sessions()
    reviewed = review([note()]); http.before_chunk = revoke
    with pytest.raises(HTTPException): build(reviewed)
    assert not N._indexes and not N._building
    assert N._slots.acquire(blocking=False); assert N._slots.acquire(blocking=False)


def test_duplicate_build_and_search_are_single_owned_requests(http):
    async def run():
        entered, release = asyncio.Event(), asyncio.Event()
        async def wait(): entered.set(); await release.wait()
        reviewed = review([note()]); http.before_client = wait
        first = asyncio.create_task(N.build('local', None, reviewed['review_id'])); await entered.wait()
        with pytest.raises(HTTPException) as error: await N.build('local', None, reviewed['review_id'])
        assert error.value.status_code == 429 and not http.requests
        release.set(); index = await first; http.before_client = None
        entered.clear(); release.clear(); http.before_client = wait
        finding = asyncio.create_task(N.search('local', None, index['index_id'], 'cable')); await entered.wait()
        with pytest.raises(HTTPException) as error: await N.search('local', None, index['index_id'], 'cable')
        assert error.value.status_code == 429 and len(http.requests) == 1
        release.set(); await finding; assert len(http.requests) == 2 and not N._searching
    asyncio.run(run())


def test_old_search_after_note_change_never_returns_stale_candidates(http):
    fact = note(); index = build(review([fact]))
    async def change(): memory.change('local', fact['id'], None)
    http.before_chunk = change
    with pytest.raises(HTTPException): search(index)
    assert not N._indexes and not N._searching


def test_batch_probe_change_rejects_replacement_without_touching_previous(http):
    facts = [note('Saved note ' + str(i)) for i in range(9)]
    old = build(review(facts)); reviewed = review(facts); count = 0
    async def changed():
        nonlocal count
        count += 1
        if count == 2: http.payload = {'model': 'fixture-embed', 'data': [{'index': 0, 'embedding': [0, 1, 0]}, {'index': 1, 'embedding': [0, 0, 1]}]}
    http.before_client = changed
    with pytest.raises(HTTPException) as error: build(reviewed)
    assert 'behavior changed' in error.value.detail and old['index_id'] in N._indexes


@pytest.mark.parametrize('bad', [None, [], {}, {'model': 'different', 'data': []},
    {'model': 'fixture-embed', 'data': [{'index': True, 'embedding': [1]}]},
    {'model': 'fixture-embed', 'data': [{'index': 1, 'embedding': [1]}]},
    *[{'model': 'fixture-embed', 'data': [{'index': 0, 'embedding': vector}]} for vector in ([], [0], [True], ['1'], [float('nan')], [float('inf')], [1e13], [1e-300], [1]*4097)],
    b'{"model":"fixture-embed","model":"fixture-embed","data":[]}', b'['*1500+b']'*1500, b'x'*(2*1024*1024+1)], ids=lambda value: type(value).__name__)
def test_malformed_bounded_vectors_never_become_an_index(bad, http):
    http.payload = b'null' if bad is None else bad
    with pytest.raises(HTTPException) as error: asyncio.run(N._embeddings({'model':'fixture-embed','api_key':'','port':12345}, ['query']))
    assert error.value.status_code == 503 and not N._indexes


def test_vector_order_is_explicit_and_dimensions_norms_and_probe_are_checked(http):
    http.payload = {'model': 'fixture-embed', 'data': [{'index': 1, 'embedding': [0, 2]}, {'index': 0, 'embedding': [3, 0]}]}
    vectors = asyncio.run(N._embeddings({'model':'fixture-embed','api_key':'','port':12345}, ['probe','query']))
    assert [list(v) for v in vectors] == [[1,0],[0,1]]
    http.payload['data'][0]['embedding'] = [1]
    with pytest.raises(HTTPException): asyncio.run(N._embeddings({'model':'fixture-embed','api_key':'','port':12345}, ['probe','query']))


@pytest.mark.parametrize('status', [301, 302, 307, 401, 429, 500])
def test_status_failure_never_follows_redirect_or_falls_back(status, http):
    http.status = status
    with pytest.raises(HTTPException) as error: build(review([note()]))
    assert str(status) in error.value.detail and len(http.requests) == 1 and not N._indexes


@pytest.mark.parametrize('failure', [TimeoutError(), httpx.ReadTimeout('fixture timeout'), httpx.ConnectError('fixture failure')])
def test_transport_failure_retains_index_and_releases_slots(failure, http):
    fact = note(); old = build(review([fact])); http.payload = failure
    with pytest.raises(HTTPException): build(review([fact]))
    assert old['index_id'] in N._indexes and not N._building


def test_routes_scope_limits_strict_review_and_no_store(client, http):
    fact = note(); body = {'notes':[ref(fact)],'port':12345,'model':'fixture-embed'}
    cap = client.get('/api/intelligence/note-search/capabilities'); assert cap.status_code == 200 and cap.headers['cache-control'] == 'no-store'
    response = client.post('/api/intelligence/note-search/review', json=body); assert response.status_code == 200 and not http.requests
    reviewed = response.json(); assert client.post('/api/intelligence/note-search/build', json={'review_id':reviewed['review_id'],'reviewed':1}).status_code == 422
    built = client.post('/api/intelligence/note-search/build', json={'review_id':reviewed['review_id'],'reviewed':True}); assert built.status_code == 200,built.text
    result = client.post('/api/intelligence/note-search/search', json={'index_id':built.json()['index_id'],'query':'cable'}); assert result.status_code == 200 and result.headers['cache-control'] == 'no-store'
    assert len(result.json()['results']) == 1
    for patch in ({'port':80},{'port':'12345'},{'model':' '},{'model':'line\r\nheader'},{'notes':[]},{'notes':[ref(fact)]*65},{'url':'https://external.invalid'},{'user_id':'other'}):
        assert client.post('/api/intelligence/note-search/review', json={**body,**patch}).status_code == 422
    assert client.post('/api/intelligence/note-search/review', content='x'*65537).status_code == 413
    assert client.post('/api/intelligence/note-search/review', content='['*1500+']'*1500).status_code == 422
    assert client.post('/api/intelligence/note-search/review', content='{"port":12345,"port":12346}').status_code == 422


def test_route_csrf_plain_http_tokens_and_browser_only_scope(client):
    fact = note(); body = {'notes':[ref(fact)],'port':12345,'model':'fixture-embed'}
    for headers in ({'origin':'https://different.invalid'},{'sec-fetch-site':'cross-site'}):
        assert client.post('/api/intelligence/note-search/review', json=body, headers=headers).status_code == 403
    assert client.post('/api/intelligence/note-search/review', json={**body,'api_key':'private-token'}).status_code == 400
    request = Request({'type':'http','method':'POST','path':'/','scheme':'https','server':('host',443),'client':('127.0.0.1',1234),'headers':[(b'authorization',b'Bearer phone')]})
    with pytest.raises(HTTPException) as error: R.authorize(request,'local')
    assert error.value.status_code == 403 and not N._reviews


def test_source_text_limit_rejects_whole_notes_before_inference(http, monkeypatch):
    facts = [{'id':str(n),'revision':'a'*64,'title':'title','text':'ü'*2000} for n in range(20)]
    monkeypatch.setattr(N.memory,'list_facts',lambda user:facts)
    with pytest.raises(HTTPException) as error: review(facts)
    assert error.value.status_code == 413 and not http.requests and not N._reviews


@pytest.mark.parametrize('action', ['revoke_other', 'discard_other', 'discard_unknown'])
def test_other_browser_cleanup_does_not_interrupt_current_index(action, http):
    a, b = S.create_session_token(), S.create_session_token(); fact = note()
    first = build(review([fact], token=a), token=a); second = build(review([fact], token=b), token=b)
    async def cleanup():
        if action == 'revoke_other': S.revoke_session_token(b)
        elif action == 'discard_other': N.discard('local', b, second['index_id'])
        else: N.discard('local', b, 'unknown-index')
    http.before_chunk = cleanup
    assert search(first, token=a)['results'][0]['id'] == fact['id']
    assert first['index_id'] in N._indexes


def test_a_failed_invalidation_hook_cannot_fail_successful_save_or_release_stale_text(http, monkeypatch):
    fact = note(); index = build(review([fact]))
    monkeypatch.setattr(N, 'invalidate', lambda user: (_ for _ in ()).throw(RuntimeError('synthetic optional hook failure')))
    saved = memory.change('local', fact['id'], 'New authoritative note')
    assert memory.list_facts('local')[0]['text'] == saved['text']
    count = len(http.requests)
    with pytest.raises(HTTPException): search(index)
    assert len(http.requests) == count


def test_review_generation_change_during_note_read_never_accepts_stale_review(http, monkeypatch):
    fact = note(); original = N._facts
    def changed(user, refs):
        selected = original(user, refs); N.invalidate(user); return selected
    monkeypatch.setattr(N, '_facts', changed)
    with pytest.raises(HTTPException) as error: review([fact])
    assert error.value.status_code == 409 and not N._reviews and not http.requests
