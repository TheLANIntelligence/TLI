"""Real encrypted synthetic stores; exporting never probes, mutates or runs AI."""
import hashlib
import json
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import tli_state as S
from intelligence import cases, case_exports as X, memory, diagnostics
from intelligence.store import write_private, private_path
from routers import case_export_routes as R
from routers.system_routes import require_session

OWNER = 'export-fixture-owner'
STAMP = '2026-09-08T12:00:00Z'


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(S, 'DATA_DIR', str(tmp_path))
    monkeypatch.setattr(S, 'CONVERSATIONS_FILE', str(tmp_path / 'conversations.json'))
    monkeypatch.setattr(diagnostics, 'run', lambda *a, **k: pytest.fail('Export must not execute a diagnostic'))
    monkeypatch.setattr(S.lm_provider, 'complete', lambda *a, **k: pytest.fail('Export must not use inference'))
    monkeypatch.setattr(R, 'require_session', lambda *a, **k: OWNER)
    X._reviews.clear()


@pytest.fixture
def api():
    app = FastAPI(); app.include_router(R.router)
    app.dependency_overrides[require_session] = lambda: OWNER
    with TestClient(app) as client:
        yield client


def seed():
    S.save_memory(OWNER, {'facts': [{'id': 'note-one', 'title': 'Printer cable', 'text': 'The private cable fix', 'created_at': STAMP},
                                   {'id': 'unselected-note', 'text': 'NEVER_EXPORT_NEIGHBOUR'}], 'last_updated': STAMP})
    S.save_conversations({'chat-one': {'user_id': OWNER, 'title': 'Private discussion', 'messages': [
        {'role': 'user', 'content': 'NEVER_EXPORT_OTHER_TURN'},
        {'role': 'assistant', 'content': 'Maybe replace the cable; not confirmed.', 'ts': STAMP, 'image': 'NEVER_EXPORT_IMAGE', 'evidence_context': {'body': 'NEVER_EXPORT_RECEIPT'}}]}})
    report = {'id': 'report-one', 'kind': 'network', 'created_at': STAMP, 'host': {'id': 'atlas-id', 'name': 'Atlas', 'node_id': 'node-private'},
        'target': None, 'scope': 'Ran on Atlas; not the phone.', 'checks': [{'id': 'ping', 'label': 'Gateway', 'status': 'pass', 'detail': '192.168.4.1 answered; no repair.', 'raw': 'NEVER_EXPORT_RAW'}],
        'findings': [{'certainty': 'likely', 'text': 'Cable may be loose.'}], 'next_steps': ['Review cable'],
        'verified_fix': {'text': 'User says improved', 'confirmed_at': STAMP, 'source': 'user_confirmation'}, '_save_request': 'NEVER_EXPORT_INTERNAL'}
    write_private(OWNER, 'diagnostics', [report])
    refs = [cases.review_evidence(OWNER, 'note', 'note-one'), cases.review_evidence(OWNER, 'report', 'report-one'), cases.review_evidence(OWNER, 'chat', 'chat-one', 1)]
    row = cases.save(OWNER, cases.Create(request_id='seed', title='Atlas queue issue', symptom='Visit http://192.168.4.1 and email owner@example.test', evidence=[cases._pointer(r) for r in refs]).model_dump())['case']
    return row


def select(row, bodies=True, format='json', indices=(0, 1, 2), **extra):
    return X.Preview(case_id=row['id'], expected_revision=row['revision'], evidence=[{**cases._pointer(row['evidence'][i]), 'include_content': bodies} for i in indices], format=format, **extra)


def request(preview, selection):
    return X.Download(selection=selection, review_token=preview['review_token'], preview_sha256=preview['preview_sha256'], reviewed=True)


def tree():
    return {str(p.relative_to(S.DATA_DIR)): p.read_bytes() for p in Path(S.DATA_DIR).rglob('*') if p.is_file()}


@pytest.mark.parametrize('format', ['html', 'text', 'json'])
def test_exact_preview_download_readers_and_unchanged_sources(api, format):
    row = seed(); chosen = select(row, format=format); before = tree()
    r = api.post('/api/intelligence/case-exports/preview', json=chosen.model_dump())
    assert r.status_code == 200 and r.headers['cache-control'] == 'no-store'
    p = r.json(); raw = p['preview'].encode()
    assert p['actions_performed'] is False and p['source_unchanged'] is True
    assert hashlib.sha256(raw).hexdigest() == p['preview_sha256'] and p['bytes'] == len(raw)
    exported = api.post('/api/intelligence/case-exports/download', json=request(p, chosen).model_dump())
    assert exported.status_code == 200 and exported.content == raw
    assert exported.headers['content-disposition'].startswith('attachment; filename="tli-troubleshooting.')
    assert exported.headers['x-content-type-options'] == 'nosniff'
    assert 'historical_observation' in p['preview'] and 'ai_interpretation' in p['preview']
    assert 'recorded_interpretations' in json.dumps(p['document']) and 'recorded_user_confirmation' in json.dumps(p['document'])
    assert 'private cable fix' in p['preview']
    for secret in ('NEVER_EXPORT_', '192.168.4.1', 'owner@example.test', 'Atlas', 'atlas-id', 'node-private'):
        assert secret not in p['preview']
    assert tree() == before
    assert all('private cable' not in json.dumps(entry) for entry in X._reviews.values())


def test_no_evidence_means_no_source_reads_and_pointer_only_survives_deleted_source(monkeypatch):
    row = seed()
    def unexpected(*a, **k): pytest.fail('Unselected/pointer-only evidence must not read source stores')
    monkeypatch.setattr(cases, 'review_evidence', unexpected)
    monkeypatch.setattr(memory, 'list_facts', unexpected)
    monkeypatch.setattr(diagnostics, 'get_report', unexpected)
    empty = X.preview(OWNER, select(row, indices=()))
    assert empty['document']['selected_evidence'] == []
    pointers = X.preview(OWNER, select(row, bodies=False))
    assert all(r['classification'] == 'historical_pointer_only' and 'content' not in r for r in pointers['document']['selected_evidence'])
    assert 'private cable fix' not in pointers['preview']


@pytest.mark.parametrize('change', ['case', 'note', 'deleted_note', 'chat', 'report', 'owner', 'redaction', 'digest', 'expired'])
def test_changed_or_unowned_reviews_fail_closed(change, monkeypatch):
    row = seed(); s = select(row); p = X.preview(OWNER, s); user = OWNER
    if change == 'case':
        data = cases.read_all(OWNER); data['cases'][0]['title'] = 'Changed'; cases._write(OWNER, data)
    elif change == 'note': memory.change(OWNER, 'note-one', 'New fix')
    elif change == 'deleted_note': memory.change(OWNER, 'note-one', None)
    elif change == 'chat':
        data = S.load_conversations(); data['chat-one']['messages'][1]['content'] = 'Changed'; S.save_conversations(data)
    elif change == 'report':
        data = diagnostics.history(OWNER); data[0]['checks'][0]['detail'] = 'Changed'; write_private(OWNER, 'diagnostics', data)
    elif change == 'owner': user = 'different-owner'
    elif change == 'redaction': s.redactions.identifiers = False
    elif change == 'digest': p['preview_sha256'] = '0' * 64
    else: monkeypatch.setattr(X.time, 'monotonic', lambda: 10**12)
    before = tree()
    with pytest.raises(HTTPException) as e: X.download(user, request(p, s))
    assert e.value.status_code in (404, 409) and tree() == before


def test_unchanged_only_owned_linked_sources_and_strict_inputs(api):
    row = seed(); s = select(row)
    missing = s.model_copy(deep=True); missing.evidence[0].id = 'unselected-note'
    assert api.post('/api/intelligence/case-exports/preview', json=missing.model_dump()).status_code == 409
    for changed in ({**s.model_dump(), 'owner': 'other'}, {**s.model_dump(), 'evidence': [s.evidence[0].model_dump()] * 2},
                    {**s.model_dump(), 'evidence': [{**s.evidence[0].model_dump(), 'message_index': 0}]},
                    {**s.model_dump(), 'redactions': {'terms': ['x'] * 41}}):
        assert api.post('/api/intelligence/case-exports/preview', json=changed).status_code == 422
    with pytest.raises(HTTPException) as e: X.preview('different-owner', s)
    assert e.value.status_code == 404


def test_redaction_review_and_html_are_inert_even_for_malicious_saved_text():
    row = seed(); data = cases.read_all(OWNER)
    data['cases'][0]['symptom'] = '<script>alert(1)</script><img src="https://outside.test/pixel"> secret-word D:\\Private\\file.txt\nAA:BB:CC:DD:EE:FF'
    cases._write(OWNER, data); row = cases.get_case(OWNER, row['id'])
    p = X.preview(OWNER, select(row, format='html', redactions={'identifiers': True, 'terms': ['secret-word', 'ai_interpretation']}))
    assert '<script>' not in p['preview'] and '<img src=' not in p['preview'] and '&lt;script&gt;' in p['preview']
    assert 'default-src' in p['preview'] and 'secret-word' not in p['preview'] and 'D:\\Private' not in p['preview'] and 'AA:BB' not in p['preview']
    assert p['document']['selected_evidence'][2]['classification'] == 'ai_interpretation'
    assert p['document']['redaction_review']['replacement_count'] > 0
    assert 'cannot find every secret' in p['preview']
    q = X.preview(OWNER, select(row, redactions={'identifiers': False, 'terms': []}))
    assert 'D:\\Private' in q['preview'] or 'D:\\\\Private' in q['preview']


def test_render_size_and_unreadable_store_rejections_never_write(monkeypatch):
    row = seed(); before = tree()
    monkeypatch.setattr(X, 'MAX_BYTES', 100)
    with pytest.raises(HTTPException) as e: X.preview(OWNER, select(row))
    assert e.value.status_code == 413 and tree() == before
    path = private_path(OWNER, 'cases'); path.write_bytes(b'corrupt fixture'); before = tree()
    with pytest.raises(HTTPException) as e: X.preview(OWNER, select(row))
    assert e.value.status_code == 503 and tree() == before


def test_report_summary_declares_omissions_and_retains_process_creation_identity():
    row = seed(); reports = diagnostics.history(OWNER)
    reports[0]['performance'] = {'process': {'name': 'Editor', 'pid': 441, 'create_time': 1234567890.125, 'exe': 'D:\\Private\\editor.exe'},
        'started_at': STAMP, 'finished_at': STAMP, 'sample_count': 30, 'expected_samples': 30,
        'summary': {'process_cpu_percent': {'mean': 12, 'max': 20, 'samples': 30}, 'private_extra': 'NEVER_EXPORT_UNKNOWN'},
        'samples': [{'private': 'NEVER_EXPORT_RAW_SAMPLE'}]}
    write_private(OWNER, 'diagnostics', reports)
    data = cases.read_all(OWNER); data['cases'][0]['evidence'][1]['revision'] = cases.revision(reports[0]); cases._write(OWNER, data)
    row = cases.get_case(OWNER, row['id'])
    p = X.preview(OWNER, select(row, indices=(1,)))
    evidence = p['document']['selected_evidence'][0]
    assert 'Raw samples' in evidence['export_scope'] and 'internal receipts' in evidence['export_scope']
    process = evidence['content']['recorded_performance']['process']
    assert process['create_time'] == 1234567890.125 and process['pid'] == '[identifier redacted]'
    assert 'NEVER_EXPORT' not in p['preview'] and "user's saved account" in p['preview']


def test_explicit_review_auth_and_post_snapshot_expiry(api, monkeypatch):
    row = seed(); s = select(row); p = X.preview(OWNER, s)
    for value in (False, 1, 'true', None):
        body = request(p, s).model_dump(); body['reviewed'] = value
        assert api.post('/api/intelligence/case-exports/download', json=body).status_code == 422
    assert api.post('/api/intelligence/case-exports/preview', json=s.model_dump(), headers={'Origin': 'https://elsewhere.test'}).status_code == 403
    original = X.prepare
    def expire(*a):
        result = original(*a)
        monkeypatch.setattr(R, 'require_session', lambda *a, **k: (_ for _ in ()).throw(HTTPException(401, 'Locked')))
        return result
    monkeypatch.setattr(X, 'prepare', expire)
    before = tree()
    assert api.post('/api/intelligence/case-exports/download', json=request(p, s).model_dump()).status_code == 401
    assert tree() == before


def test_concurrent_downloads_are_identical_read_only_not_consumed_or_replayed():
    row = seed(); s = select(row); p = X.preview(OWNER, s); before = tree()
    with ThreadPoolExecutor(4) as pool:
        result = list(pool.map(lambda _: X.download(OWNER, request(p, s))[0], range(4)))
    assert len(set(result)) == 1 and result[0] == p['preview'].encode() and tree() == before
