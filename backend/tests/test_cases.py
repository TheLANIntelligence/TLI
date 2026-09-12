"""Synthetic account journals: no inference, devices or live persistence."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import tli_state as S
from intelligence import cases as C, memory, devices
from intelligence.store import private_path
from routers import cases_routes
from routers.system_routes import require_session

OWNER = "synthetic-owner"


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "CONVERSATIONS_FILE", str(tmp_path / "conversations.json"))
    monkeypatch.setattr(devices, "get", lambda ident: {"id": ident, "kind": "computer", "name": "Synthetic computer", "node_id": "fixture"} if ident == "host" else (_ for _ in ()).throw(HTTPException(404, "Missing")))
    from ai.ai_manager import BundledAIManager
    monkeypatch.setattr(BundledAIManager, "get", lambda: pytest.fail("Workspace must not launch inference"))
    monkeypatch.setattr(S.lm_provider, "complete", lambda **kw: pytest.fail("No AI calls"))


@pytest.fixture
def api():
    app = FastAPI(); app.include_router(cases_routes.router)
    app.dependency_overrides[require_session] = lambda: OWNER
    with TestClient(app) as client: yield client


def draft(**extra):
    return {"request_id": "synthetic-create-one", "title": "Printer stalls", "symptom": "Queue remains unchanged", **extra}


def create(**extra):
    return C.save(OWNER, C.Create(**draft(**extra)).model_dump())["case"]


def update(row, **extra):
    fields = {key: row[key] for key in ("title", "symptom", "status", "archived", "steps", "resolution")}
    fields.update(computer_id=(row.get("computer") or {}).get("id"), evidence=[C._pointer(item) for item in row["evidence"]], expected_revision=row["revision"], **extra)
    return C.Update(**fields).model_dump()


def test_create_encrypted_owned_and_no_actions(api):
    result = api.post('/api/intelligence/cases', json=draft()).json()
    assert result['ok'] and result['actions_performed'] is False
    assert result['case']['status'] == 'open' and len(result['case']['revision']) == 64
    raw = private_path(OWNER, 'cases').read_text()
    assert json.loads(raw)['_tli_enc'] == 1 and 'Printer stalls' not in raw
    assert C.list_cases('other')['items'] == []
    with pytest.raises(HTTPException) as err: C.get_case('other', result['case']['id'])
    assert err.value.status_code == 404
    assert api.get('/api/intelligence/cases').headers['cache-control'] == 'no-store'


def test_concurrent_duplicate_create_one_record_and_receipt():
    values = C.Create(**draft()).model_dump()
    with ThreadPoolExecutor(4) as pool: results = list(pool.map(lambda _: C.save(OWNER, values), range(4)))
    assert len({row['case']['id'] for row in results}) == 1
    assert sum(not row['already_saved'] for row in results) == 1
    assert len(C.read_all(OWNER)['cases']) == 1
    with pytest.raises(HTTPException) as err: C.save(OWNER, C.Create(**draft(title='Different')).model_dump())
    assert err.value.status_code == 409


def test_compare_and_swap_retains_current_and_deleted_create_cannot_resurrect():
    row = create()
    changed = C.save(OWNER, update(row, title='Reviewed printer'), row['id'])['case']
    with pytest.raises(HTTPException) as err: C.save(OWNER, update(row, title='Stale'), row['id'])
    assert err.value.status_code == 409 and C.get_case(OWNER, row['id'])['title'] == 'Reviewed printer'
    C.remove(OWNER, row['id'], changed['revision'])
    with pytest.raises(HTTPException) as err: create()
    assert err.value.status_code == 409 and C.list_cases(OWNER)['total'] == 0


def test_removed_computer_snapshot_preserved_for_existing_case(monkeypatch):
    row = create(computer_id='host')
    monkeypatch.setattr(devices, 'get', lambda _: (_ for _ in ()).throw(HTTPException(404, 'Missing')))
    changed = C.save(OWNER, update(row, title='Still tracking'), row['id'])['case']
    assert changed['computer'] == row['computer']
    with pytest.raises(HTTPException): create(request_id='another', computer_id='missing')


def test_evidence_owned_fresh_and_unavailable_sources_remain_pointers():
    S.save_memory(OWNER, {'facts': [{'id': 'note-one', 'text': 'A prior fix', 'title': 'Prior fix'}], 'last_updated': None})
    ref = C.review_evidence(OWNER, 'note', 'note-one')
    row = create(evidence=[C._pointer(ref)])
    assert row['evidence'][0]['availability'] == 'current'
    memory.change(OWNER, 'note-one', 'Changed advice')
    assert C.get_case(OWNER, row['id'])['evidence'][0]['availability'] == 'changed'
    with pytest.raises(HTTPException) as err: create(request_id='new', evidence=[C._pointer(ref)])
    assert err.value.status_code == 409
    S.save_memory(OWNER, {'facts': [], 'last_updated': None})
    row = C.save(OWNER, update(row, title='Retained history'), row['id'])['case']
    assert row['evidence'][0]['availability'] == 'unavailable'
    assert 'A prior fix' not in json.dumps(C.read_all(OWNER))
    with pytest.raises(HTTPException): C.review_evidence('other', 'note', 'note-one')


def test_chat_links_completed_owned_turns_only():
    S.save_conversations({'chat': {'user_id': OWNER, 'messages': [{'role': 'assistant', 'content': 'Maybe try it', 'state': 'interrupted'}]}})
    with pytest.raises(HTTPException): C.review_evidence(OWNER, 'chat', 'chat', 0)
    S.save_conversations({'chat': {'user_id': OWNER, 'messages': [{'role': 'assistant', 'content': 'Maybe try it'}]}})
    ref = C.review_evidence(OWNER, 'chat', 'chat', 0)
    assert ref['message_index'] == 0
    with pytest.raises(HTTPException): C.review_evidence('other', 'chat', 'chat', 0)


@pytest.mark.parametrize('extra', [{'status': 'resolved'}, {'title': ' '}, {'steps': [{'id':'s','text':'Run','status':'done'}]}, {'computer_id': 'missing'}, {'evidence': [{'kind':'note','id':'x','revision':'a'*64,'message_index':0}]}, {'owner':'other'}])
def test_invalid_or_invented_fields_rejected_without_store(api, extra):
    assert api.post('/api/intelligence/cases', json=draft(**extra)).status_code in (422, 404)
    assert not private_path(OWNER, 'cases').exists()


def test_missing_key_and_corrupt_store_never_replaced(api):
    row = create()
    path = private_path(OWNER, 'cases'); original = path.read_bytes()
    key = Path(S.DATA_DIR) / 'memory_key.bin'; key.unlink()
    assert api.post('/api/intelligence/cases', json=draft(request_id='next')).status_code == 503
    assert path.read_bytes() == original and not key.exists()
    with pytest.raises(Exception): S._get_mem_key()
    assert not key.exists()
    path.write_text('{invalid'); before = path.read_bytes()
    assert api.get('/api/intelligence/cases').status_code == 503 and path.read_bytes() == before


def test_failed_atomic_write_retains_bytes_and_auth_applies(api, monkeypatch):
    row = create(); path = private_path(OWNER, 'cases'); original = path.read_bytes()
    monkeypatch.setattr(C, 'write_private', lambda *a: (_ for _ in ()).throw(OSError('fixture disk')))
    assert api.put('/api/intelligence/cases/' + row['id'], json=update(row, title='Not saved')).status_code == 503
    assert path.read_bytes() == original
    def denied(): raise HTTPException(401, 'Locked')
    api.app.dependency_overrides[require_session] = denied
    for route in ('', '/health', '/capabilities', '/' + row['id']): assert api.get('/api/intelligence/cases' + route).status_code == 401


def test_unreadable_linked_report_is_unavailable_not_empty_or_current(monkeypatch):
    from intelligence.store import write_private
    write_private(OWNER, 'diagnostics', [{'id':'report-one','kind':'network','created_at':'2026-09-08T12:00:00Z'}])
    ref = C.review_evidence(OWNER, 'report', 'report-one')
    row = create(evidence=[C._pointer(ref)])
    monkeypatch.setattr(C.diagnostics, 'get_report', lambda *a: (_ for _ in ()).throw(HTTPException(503, 'Unreadable')))
    current = C.get_case(OWNER, row['id'])
    assert current['evidence'][0]['availability'] == 'unavailable'
    assert C.save(OWNER, update(current, title='Keep the historical link'), row['id'])['case']['evidence'][0]['revision'] == ref['revision']


def test_ambiguous_legacy_source_ids_are_not_silently_linked():
    from intelligence.store import write_private
    S.save_memory(OWNER, {'facts':[{'id':'duplicate','text':'First'},{'id':'duplicate','text':'Second'}],'last_updated':None})
    write_private(OWNER, 'diagnostics', [{'id':'duplicate','kind':'network'},{'id':'duplicate','kind':'system'}])
    for kind in ('note','report'):
        with pytest.raises(HTTPException) as err: C.review_evidence(OWNER, kind, 'duplicate')
        assert err.value.status_code == 409
    assert not private_path(OWNER, 'cases').exists()


def test_broken_link_store_cannot_be_replaced_or_exported_as_empty(tmp_path):
    from intelligence import backups
    path = private_path(OWNER, 'cases'); destination = tmp_path / 'never-created.json'
    try: path.symlink_to(destination)
    except OSError: pytest.skip('This platform does not permit the isolated symlink fixture')
    with pytest.raises(HTTPException) as err: create()
    assert err.value.status_code == 503 and path.is_symlink() and not destination.exists()
    with pytest.raises(HTTPException): backups._snapshot(OWNER, 2)
    assert path.is_symlink() and not destination.exists()
