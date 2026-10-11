"""Versioned saved work and real current-reader recovery using synthetic data."""
import hashlib
import json
from pathlib import Path
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import tli_state as S
from intelligence import backups as B, cases as C, recovery as R, recovery_readback as RB
from intelligence.store import private_path, write_private
from routers import backup_routes
from routers.system_routes import require_session

OWNER = 'synthetic-source'
PASSWORD = 'Synthetic-only archive password'


@pytest.fixture
def setup(tmp_path, monkeypatch):
    live = tmp_path / 'live'; live.mkdir(); data = live / 'data'; data.mkdir()
    monkeypatch.setattr(S, 'BASE_DIR', str(live)); monkeypatch.setattr(S, 'DATA_DIR', str(data))
    monkeypatch.setattr(S, 'CONVERSATIONS_FILE', str(data / 'conversations.json'))
    monkeypatch.setattr(B, '_key', lambda password, salt: hashlib.sha256(password.encode() + salt).digest())
    monkeypatch.setattr(R, '_drive_type', lambda _: 3)
    monkeypatch.setattr(B.data_health, '_host', lambda: {'id':'synthetic-host','name':'Fixture'})
    S.save_memory(OWNER, {'facts':[{'id':'prior-note','text':'A recorded setup detail','title':'Prior setup'}],'last_updated':None})
    S.save_conversations({'saved-chat':{'id':'saved-chat','user_id':OWNER,'messages':[{'role':'assistant','content':'A suggestion, not a verified fix.'}]}})
    write_private(OWNER, 'diagnostics', [{'id':'saved-report','kind':'network','created_at':'2026-09-08T12:00:00Z','checks':[],'findings':[]}])
    refs = [C._pointer(C.review_evidence(OWNER, kind, ident, index)) for kind,ident,index in [('note','prior-note',None),('report','saved-report',None),('chat','saved-chat',0)]]
    row = C.save(OWNER, C.Create(request_id='one', title='Network issue', symptom='Slow yesterday',
          evidence=refs, steps=[{'id':'step-1','text':'Reviewed saved report','status':'tried','outcome':'No cause confirmed'}]).model_dump())['case']
    return tmp_path, row


def test_v1_exact_scope_and_v2_explicit_scope(setup):
    root, row = setup
    v1 = B.create_archive(OWNER, PASSWORD)
    v2 = B.create_archive(OWNER, PASSWORD, 'saved-work-v2')
    old = B.verify_archive(v1, PASSWORD); new = B.verify_archive(v2, PASSWORD)
    assert v1.startswith(B.MAGIC) and v2.startswith(B.MAGIC_V2)
    assert old['schema_version'] == 1 and old['protocol'] == B.PROTOCOL and 'cases' not in old['counts']
    assert set(B._unpack(B._decrypt(v1, PASSWORD))) == set(B.ALL_NAMES)
    assert new['schema_version'] == 2 and new['protocol'] == B.PROTOCOL_V2 and new['counts']['cases'] == 1
    assert new['manifest']['included_areas'] == [*B.INCLUDED_IDS, 'troubleshooting']
    assert new['source']['source_formats']['cases'] == 'encrypted'
    assert 'cases.json' in B._unpack(B._decrypt(v2, PASSWORD))


def test_real_v2_recovery_preserves_case_and_fresh_keys_without_activation(setup):
    root, row = setup
    source = private_path(OWNER, 'cases'); original = source.read_bytes()
    source_key = (Path(S.DATA_DIR) / 'memory_key.bin').read_bytes()
    blob = B.create_archive(OWNER, PASSWORD, 'saved-work-v2')
    dest = root / 'recovered-work'
    review = R.review_archive(blob, PASSWORD, 'current-owner', str(dest))
    assert not dest.exists() and review['counts']['cases'] == 1
    result = R.create_copy(blob, PASSWORD, 'current-owner', str(dest), review['review_token'])
    assert result['activated'] is False and result['readback']['counts']['cases'] == 1
    assert all(result['readback']['checks'].values())
    assert source.read_bytes() == original
    assert (dest / 'data/memory_key.bin').read_bytes() != source_key
    assert not (dest / 'data/node_identity.json').exists()
    assert (dest / RB.CASE_FILE).exists()


@pytest.mark.parametrize('archive_format', [None, 'saved-work-v2'])
def test_performance_and_reviewed_check_reports_reopen_unchanged(setup, archive_format):
    """Additive report metadata survives each archive version and real readers."""
    from intelligence import diagnostics as D
    root, case = setup
    host = {'id': 'historical-host-id', 'name': 'Studio', 'node_id': 'old-node'}
    measured = {
        'id': 'performance-synthetic', 'kind': 'performance',
        'created_at': '2026-09-08T12:00:30Z', 'host': host, 'target': host,
        'scope': 'Historical 30-second sample on Studio. No cause established.',
        'checks': [{'id': 'cpu', 'label': 'Host CPU', 'status': 'warn',
                    'detail': 'Two valid samples; incomplete coverage.'}],
        'findings': [], 'next_steps': [], 'verified_fix': None,
        'performance': {'schema_version': 1, 'status': 'partial',
            'process': {'pid': 123, 'create_time': 1788840000.0,
                        'name': 'Synthetic.exe', 'exe': 'C:\\Synthetic\\Synthetic.exe'},
            'duration_seconds': 30, 'valid_samples': 2,
            'samples': [{'host_cpu_percent': 0, 'process_rss_bytes': None},
                        {'host_cpu_percent': 95, 'process_rss_bytes': 1000000}]}}
    saved = D.save_report(OWNER, measured, 'performance-save-once')
    check = {**measured, 'id': 'reviewed-system', 'kind': 'system', 'target': None,
             '_check_request': {'key': 'a' * 64, 'signature': 'b' * 64}}
    check.pop('performance')
    D.save_report(OWNER, check)
    before_reports = D.history(OWNER)
    paths = [private_path(OWNER, 'diagnostics'), private_path(OWNER, 'cases'),
             Path(S.DATA_DIR) / 'memory_key.bin', Path(S.CONVERSATIONS_FILE)]
    before_bytes = {path: path.read_bytes() for path in paths}
    # Public function uses its preserved positional format selector.
    blob = B.create_archive(OWNER, PASSWORD, archive_format) if archive_format else B.create_archive(OWNER, PASSWORD)
    values = B._unpack(B._decrypt(blob, PASSWORD))
    assert json.loads(values['diagnostics.json']) == before_reports
    assert saved['performance']['samples'][0] == {'host_cpu_percent': 0, 'process_rss_bytes': None}
    destination = root / ('performance-v2' if archive_format else 'performance-v1')
    review = R.review_archive(blob, PASSWORD, 'recovery-reviewer', str(destination))
    result = R.create_copy(blob, PASSWORD, 'recovery-reviewer', str(destination), review['review_token'])
    assert result['activated'] is False
    assert result['readback']['counts']['diagnostics'] == len(before_reports)
    assert all(result['readback']['checks'].values())
    assert all(path.read_bytes() == value for path, value in before_bytes.items())
    assert D.history(OWNER) == before_reports


@pytest.mark.parametrize('defect', ['checksum','case_schema','wrong_envelope','missing_cases','unknown_entry'])
def test_v2_tampering_rejected_no_partial_acceptance(setup, defect):
    import io, zipfile
    blob = B.create_archive(OWNER, PASSWORD, 'saved-work-v2')
    entries = B._unpack(B._decrypt(blob, PASSWORD))
    if defect == 'checksum': entries['cases.json'] = b'{}'
    elif defect == 'case_schema':
        values, counts, stamp = B._snapshot(OWNER, 2)
        values['cases.json']['cases'][0]['status'] = 'automatically-fixed'
        entries = B._unpack(B._pack(values, counts, stamp, 2))
    elif defect == 'missing_cases': entries.pop('cases.json')
    elif defect == 'unknown_entry': entries['unknown.json'] = b'{}'
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_STORED) as archive:
        for name, raw in entries.items(): archive.writestr(name, raw)
    damaged = B._encrypt(stream.getvalue(), PASSWORD, 1 if defect == 'wrong_envelope' else 2)
    with pytest.raises(HTTPException) as err: B.verify_archive(damaged, PASSWORD)
    assert err.value.status_code == 422


def test_missing_case_key_rejects_v2_while_v1_remains_its_original_scope(setup):
    path = private_path(OWNER, 'cases'); before = path.read_bytes()
    (Path(S.DATA_DIR) / 'memory_key.bin').unlink()
    with pytest.raises(HTTPException) as err: B.create_archive(OWNER, PASSWORD, 'saved-work-v2')
    assert err.value.status_code == 503 and path.read_bytes() == before
    # v1 still checks every area within its original scope (including notes).
    with pytest.raises(HTTPException): B.create_archive(OWNER, PASSWORD)
    assert not (Path(S.DATA_DIR) / 'memory_key.bin').exists()


def test_http_explicit_format_returns_matching_protocol_and_unknown_rejected(setup):
    app = FastAPI(); app.include_router(backup_routes.router)
    token = S.create_session_token(OWNER)
    with TestClient(app, base_url='https://fixture.test', cookies={'tli_session':token}) as client:
        r = client.post('/api/intelligence/backups/create', json={'password':PASSWORD,'request_id':'request-v2-synthetic-one','format':'saved-work-v2'})
        assert r.status_code == 200 and r.headers['X-TLI-Backup-Protocol'] == B.PROTOCOL_V2
        assert B.verify_archive(r.content, PASSWORD)['counts']['cases'] == 1
        r = client.post('/api/intelligence/backups/create', json={'password':PASSWORD,'request_id':'request-bad-synthetic-one','format':'future'})
        assert r.status_code == 422


def test_v2_accepts_readable_case_envelope_above_legacy_raw_limit(setup):
    import copy
    value = C.read_all(OWNER)
    sample = copy.deepcopy(value['cases'][0])
    sample['evidence'] = []
    sample['steps'] = [{'id':f'step-{i}', 'text':'x' * 1000, 'status':'tried',
                       'outcome':'y' * 2000} for i in range(30)]
    value['cases'] = [{**copy.deepcopy(sample), 'id':f'case-{i:032x}'} for i in range(144)]
    value['creates'] = {}
    assert C.validate_store(value) == 144
    assert 12 * 1024 * 1024 < len(C.encoded(value)) < C.MAX_BYTES
    write_private(OWNER, 'cases', value)
    path = private_path(OWNER, 'cases')
    before = path.read_bytes()
    assert len(before) > B.MAX_SOURCE_BYTES
    assert C.read_all(OWNER) == value

    # The v1 reader keeps its original raw-file limit. Only v2 cases opt in
    # to the ordinary cases reader's larger encrypted-envelope allowance.
    with pytest.raises(HTTPException) as error:
        B._read_existing(path, 'memory_key.bin', aad=f'cases:{OWNER}'.encode(), encrypted_required=True)
    assert error.value.status_code == 413
    legacy = B.create_archive(OWNER, PASSWORD)
    assert B.verify_archive(legacy, PASSWORD)['schema_version'] == 1
    blob = B.create_archive(OWNER, PASSWORD, 'saved-work-v2')
    receipt = B.verify_archive(blob, PASSWORD)
    assert receipt['counts']['cases'] == 144
    assert len(blob) <= B.MAX_ARCHIVE_BYTES
    archived = B._unpack(B._decrypt(blob, PASSWORD))
    assert json.loads(archived['cases.json']) == value
    assert path.read_bytes() == before
