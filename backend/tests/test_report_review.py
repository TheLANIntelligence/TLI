"""User-reviewed repeated checks preserve old evidence and cannot retarget."""
import copy
from types import SimpleNamespace
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import tli_state as S
from intelligence import diagnostics as D, devices, diagnostic_workflow as W, report_review as R
from intelligence.store import private_path
from routers.intelligence_routes import router
from routers.system_routes import require_session

HOST = {"id": "host-one", "node_id": "host-one", "name": "Study"}
DEVICE = {"id": "device-one", "name": "Study", "kind": "computer", "address": "192.0.2.9", "relay": None, "source": "mesh", "node_id": "peer-one"}


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(devices, "node", lambda: copy.deepcopy(HOST))
    monkeypatch.setattr(devices, "get", lambda ident: copy.deepcopy(DEVICE) if ident == DEVICE["id"] else (_ for _ in ()).throw(HTTPException(404, "Unavailable")))
    monkeypatch.setattr(D.psutil, "virtual_memory", lambda: SimpleNamespace(percent=25))
    monkeypatch.setattr(D.psutil, "disk_partitions", lambda **kw: [])
    monkeypatch.setattr(D.psutil, "cpu_percent", lambda **kw: pytest.fail("No unreviewed measurement"))
    monkeypatch.setattr(D, "tcp", lambda *a: pytest.fail("No unreviewed network operation"))
    W._requests.clear()


def record(ident="old-one", **extra):
    return {"id": ident, "created_at": "2026-09-08T10:00:00Z", "host": copy.deepcopy(HOST), "target": None,
            "kind": "system", "internet_checks": False, "scope": "Historical host-only short sample.",
            "checks": [{"id": "cpu", "label": "CPU", "status": "fail", "detail": "Historical high reading."},
                       {"id": "ram", "label": "Memory", "status": "unavailable", "detail": "No reading."}],
            "findings": [], "next_steps": [], "verified_fix": None, **extra}


def client(user="owner"):
    app = FastAPI(); app.include_router(router)
    app.dependency_overrides[require_session] = lambda: user
    return TestClient(app)


def seed(row=None):
    return D.save_report("owner", row or record())


def test_review_has_no_calls_and_repeat_is_explicit_idempotent_and_preserves_source(monkeypatch):
    original = seed()
    with client() as api:
        response = api.get('/api/intelligence/diagnostics/old-one/repeat-review')
        assert response.status_code == 200 and response.headers['cache-control'] == 'no-store'
        review = response.json()
        assert review['actions_performed'] is False and review['available'] is True
        assert review['request']['internet'] is False
        assert D.history('owner') == [original]
        calls = []
        monkeypatch.setattr(D.psutil, 'cpu_percent', lambda **kw: calls.append(kw) or 20)
        body = {**review['request'], 'request_id': 'repeat-one'}
        result = api.post('/api/intelligence/diagnostics', json=body)
        assert result.status_code == 200, result.text
        report = result.json()
        assert report['id'] != original['id'] and len(calls) == 1
        assert report['comparison']['report_id'] == 'old-one'
        assert report['comparison']['comparable'] is True
        assert report['comparison']['changes'][0]['before'] == 'fail'
        assert report['comparison']['changes'][0]['after'] == 'pass'
        assert D.get_report('owner', 'old-one') == original
        W._requests.clear()  # persisted receipts survive process restart
        assert api.post('/api/intelligence/diagnostics', json=body).json()['id'] == report['id']
        assert len(calls) == 1


def test_changed_or_missing_source_rejects_before_measurement():
    original = seed()
    review = R.repeat_review('owner', original['id'])
    D.confirm_fix('owner', original['id'], 'I recorded a later outcome')
    with client() as api:
        result = api.post('/api/intelligence/diagnostics', json={**review['request'], 'request_id': 'changed'})
        assert result.status_code == 409
        assert 'original report changed' in result.json()['detail']
    with client('other') as api:
        assert api.get('/api/intelligence/diagnostics/old-one/repeat-review').status_code == 404


@pytest.mark.parametrize('changed', ['host', 'address', 'relay'])
def test_repeat_cannot_retarget_a_saved_identity(changed, monkeypatch):
    seed(record(kind='device', target=copy.deepcopy(DEVICE)))
    if changed == 'host': monkeypatch.setattr(devices, 'node', lambda: {**HOST, 'id': 'different-host'})
    else: monkeypatch.setattr(devices, 'get', lambda _: {**DEVICE, changed: '192.0.2.10' if changed == 'address' else 1})
    value = R.repeat_review('owner', 'old-one')
    assert value['available'] is False and value['request'] is None
    assert 'changed' in value['reason']


def test_duplicate_request_is_bound_to_original_report(monkeypatch):
    seed(); seed(record('old-two'))
    monkeypatch.setattr(D.psutil, 'cpu_percent', lambda **kw: 10)
    with client() as api:
        a, b = [R.repeat_review('owner', name)['request'] for name in ('old-one', 'old-two')]
        assert api.post('/api/intelligence/diagnostics', json={**a, 'request_id': 'same'}).status_code == 200
        assert api.post('/api/intelligence/diagnostics', json={**b, 'request_id': 'same'}).status_code == 409


def test_changed_coverage_is_not_zero_or_success_and_comparison_has_no_writes():
    a = seed(); b = record('next', created_at='2026-09-08T11:00:00Z')
    b['checks'] = [{'id': 'cpu', 'label': 'CPU', 'status': 'unavailable', 'detail': 'Missing.'},
                   {'id': 'disk:X', 'label': 'Drive X', 'status': 'pass', 'detail': 'Sample.'}]
    seed(b)
    path = private_path('owner', 'diagnostics'); before = path.read_bytes()
    with client() as api:
        value = api.get('/api/intelligence/diagnostics/old-one/compare/next').json()
    assert value['actions_performed'] is False and value['comparison']['comparable'] is True
    rows = {r['check']: r for r in value['comparison']['checks']}
    assert rows['ram']['after'] == 'not_recorded'
    assert rows['disk:X']['before'] == 'not_recorded'
    assert rows['cpu']['after'] == 'unavailable'
    assert path.read_bytes() == before
    with client('other') as api:
        assert api.get('/api/intelligence/diagnostics/old-one/compare/next').status_code == 404


@pytest.mark.parametrize('mutate', [
    lambda r: r.update(host={**HOST, 'id': 'other'}),
    lambda r: r.update(internet_checks=True),
    lambda r: r.pop('internet_checks'),
    lambda r: r['checks'].append(copy.deepcopy(r['checks'][0])),
    lambda r: r.update(created_at='invalid'),
])
def test_unknown_or_incompatible_comparisons_remain_explicit(mutate):
    a, b = record(), record('next')
    mutate(b)
    value = R.compare(a, b)
    assert value['comparable'] is False and value['reason'] and not value['changes']


def test_renamed_host_is_same_identity_but_changed_device_address_is_not_comparable():
    a, b = record(kind='device', target=copy.deepcopy(DEVICE)), record('next', kind='device', target=copy.deepcopy(DEVICE))
    b['host']['name'] = 'Renamed'
    assert R.compare(a, b)['comparable'] is True
    b['target']['address'] = '192.0.2.99'
    assert R.compare(a, b)['comparable'] is False


def test_partial_repeat_contract_rejected_and_no_source_modified():
    seed()
    with client() as api:
        for body in ({'kind': 'system', 'repeat_of': 'old-one'}, {'kind': 'system', 'expected_report_revision': 'a'*64}):
            assert api.post('/api/intelligence/diagnostics', json=body).status_code == 422
    app = FastAPI(); app.include_router(router)
    def locked(): raise HTTPException(401, 'Locked')
    app.dependency_overrides[require_session] = locked
    with TestClient(app) as api:
        assert api.get('/api/intelligence/diagnostics/old-one/repeat-review').status_code == 401
    assert len(D.history('owner')) == 1
