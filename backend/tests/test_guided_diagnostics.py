"""Synthetic reviewed scopes, encrypted report saves and duplicate requests."""
import copy
import threading
from concurrent.futures import ThreadPoolExecutor
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import tli_state as S
from intelligence import devices, diagnostics as D, diagnostic_workflow as W
from intelligence.store import private_path
from routers.intelligence_routes import router
from routers.system_routes import require_session

HOST = {"id": "host", "node_id": "host", "name": "Study", "kind": "computer", "source": "local_node"}
OTHER = {"id": "peer", "node_id": "fixture-peer", "name": "Study", "kind": "computer", "source": "mesh", "address": "192.0.2.5"}
REAL_GET = devices.get


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(devices, "node", lambda: copy.deepcopy(HOST))
    def get(ident):
        if ident not in {"host", "peer"}:
            raise HTTPException(404, "Computer unavailable")
        return copy.deepcopy(HOST if ident == "host" else OTHER)
    monkeypatch.setattr(devices, "get", get)
    W._requests.clear()


def report(**extra):
    return {"id": "observation-one", "created_at": "2026-09-08T10:00:00Z", "kind": "performance", "host": HOST,
            "target": HOST, "checks": [], "findings": [], "next_steps": [], "scope": "Host-only synthetic observation", **extra}


def test_choices_are_read_only_and_preserve_duplicate_name_identity(monkeypatch):
    monkeypatch.setattr(D, "run", lambda *a, **k: pytest.fail("Options must not run checks"))
    local = W.options("host")
    assert local["actions_performed"] is False
    assert all(x["available"] for x in local["options"])
    remote = W.options("peer")
    assert [x["id"] for x in remote["options"] if x["available"]] == ["device"]
    assert remote["options"][2]["measured_target"]["id"] == "peer"
    assert all(not x["available"] for x in W.options()["options"])
    with pytest.raises(HTTPException): W.options("missing")


def test_performance_destination_preserves_installed_companion_contract():
    option = next(row for row in W.options("host")["options"] if row["kind"] == "performance")
    # Released Companion validates this legacy field even though it offers no launch button.
    assert option["panel"] == "panel-games"
    assert option["desktop_panel"] == "panel-performance"
    assert "App performance check" in option["detail"]


def test_reviewed_scope_rejects_wrong_host_remote_resources_or_changed_address(monkeypatch):
    monkeypatch.setattr(D, "run", lambda *a, **k: pytest.fail("Rejected check must not run"))
    with pytest.raises(HTTPException) as e:
        W.run_reviewed("owner", "system", expected_host_id="peer", request_id="a")
    assert e.value.status_code == 409
    with pytest.raises(HTTPException):
        W.run_reviewed("owner", "system", "peer", expected_host_id="host", request_id="b")
    old = W.scope("device", "peer")["revision"]
    monkeypatch.setattr(devices, "get", lambda _: {**OTHER, "address": "192.0.2.6"})
    with pytest.raises(HTTPException) as e:
        W.run_reviewed("owner", "device", "peer", expected_host_id="host", request_id="c", expected_scope=old)
    assert e.value.status_code == 409


def test_explicit_internet_review_has_a_different_scope():
    network = next(x for x in W.options("host")["options"] if x["id"] == "network")
    assert network["scope_revision"] != network["internet_scope_revision"]
    assert "1.1.1.1" in network["internet_detail"]


def test_remote_review_runs_real_handler_on_reviewed_target_once(monkeypatch):
    calls = []
    monkeypatch.setattr(D, "tcp", lambda address, port: calls.append((address, port)) or ("pass", "Synthetic TCP response; function untested."))
    app = FastAPI(); app.include_router(router)
    app.dependency_overrides[require_session] = lambda: "owner"
    with TestClient(app) as api:
        options = api.get('/api/intelligence/diagnostics/options?computer_id=peer').json()
        option = next(row for row in options['options'] if row['id'] == 'device')
        body = {'kind': 'device', 'target_id': 'peer', 'internet': False,
                'expected_host_id': 'host', 'expected_scope': option['scope_revision'], 'request_id': 'reviewed-remote'}
        result = api.post('/api/intelligence/diagnostics', json=body)
        assert result.status_code == 200, result.text
        value = result.json()
        assert value['host']['id'] == 'host' and value['target']['id'] == 'peer'
        assert value['target']['source'] == 'mesh'
        assert calls == [('192.0.2.5', 80), ('192.0.2.5', 443)]
        W._requests.clear()
        assert api.post('/api/intelligence/diagnostics', json=body).json()['id'] == value['id']
        assert len(calls) == 2
        saved = D.get_report('owner', value['id'])
        assert saved == {key: item for key, item in value.items() if key != 'recorded_facts'}
        from intelligence.report_facts import build
        assert value['recorded_facts'] == build(saved)
        assert 'recorded_facts' not in saved


def test_actual_inventory_local_id_can_review_and_run_host_check(monkeypatch):
    from types import SimpleNamespace
    from routers import home_power
    monkeypatch.setattr(devices, 'get', REAL_GET)
    monkeypatch.setattr(S, 'load_shelly_registry', lambda: [])
    monkeypatch.setattr(S, 'load_mesh_directory', lambda: {})
    monkeypatch.setattr(home_power, 'get_runtime', lambda: None)
    monkeypatch.setattr(D.psutil, 'cpu_percent', lambda interval: 0)
    monkeypatch.setattr(D.psutil, 'virtual_memory', lambda: SimpleNamespace(percent=43))
    monkeypatch.setattr(D.psutil, 'disk_partitions', lambda all=False: [])
    monkeypatch.setattr(D, 'tcp', lambda *a: pytest.fail('No network check requested'))
    selected = devices.inventory()['devices'][0]
    assert selected['id'] == 'node-host' and devices.node()['id'] == 'host'
    options = W.options(selected['id'])
    assert all(row['available'] for row in options['options'])
    option = options['options'][0]
    result = W.run_reviewed('owner', 'system', expected_host_id=option['execution_host']['id'],
                           expected_scope=option['scope_revision'], request_id='actual-host-id')
    assert result['host']['id'] == 'host' and result['target'] is None
    assert result['checks'][0]['detail'] == 'CPU usage was 0% in this sample.'
    assert D.run('owner', 'system', selected['id'])['target'] is None


def test_legacy_mismatched_host_targets_reject_before_sampling(monkeypatch):
    monkeypatch.setattr(D.psutil, 'cpu_percent', lambda **kw: pytest.fail('Rejected target must not sample'))
    monkeypatch.setattr(D, 'gateway', lambda: pytest.fail('Rejected target must not inspect networking'))
    for kind in ['system', 'network']:
        with pytest.raises(HTTPException) as error:
            D.run('owner', kind, 'peer')
        assert error.value.status_code == 422
    with pytest.raises(HTTPException): D.run('owner', 'system', None, True)
    app = FastAPI(); app.include_router(router)
    app.dependency_overrides[require_session] = lambda: 'owner'
    with TestClient(app) as api:
        assert api.post('/api/intelligence/diagnostics', json={'kind': 'system', 'target_id': 'peer'}).status_code == 422
        assert api.post('/api/intelligence/diagnostics', json={'kind': 'system', 'internet': True}).status_code == 422
    assert D.history('owner') == []


def test_report_save_is_encrypted_idempotent_and_preserves_confirmed_updates():
    value = report(performance={"samples": [{"cpu": 0, "ram": None}]})
    with ThreadPoolExecutor(4) as pool:
        results = list(pool.map(lambda _: D.save_report("owner", value, "save-one"), range(4)))
    assert len(D.history("owner")) == 1
    assert all(r["id"] == value["id"] for r in results)
    assert "Host-only synthetic observation" not in private_path("owner", "diagnostics").read_text()
    assert D.history("other") == []
    from intelligence.store import write_private
    modified = D.history("owner"); modified[0]["verified_fix"] = {"text": "User confirmed improvement"}
    write_private("owner", "diagnostics", modified)
    assert D.save_report("owner", value, "save-one")["verified_fix"]["text"] == "User confirmed improvement"
    with pytest.raises(HTTPException) as e:
        D.save_report("owner", {**value, "scope": "Different observation"}, "save-one")
    assert e.value.status_code == 409
    assert len(D.history("owner")) == 1


def test_request_inflight_and_persisted_receipts_prevent_repeated_checks(monkeypatch):
    entered, release = threading.Event(), threading.Event()
    calls = []
    def fake_run(user, kind, target, internet, **kwargs):
        calls.append(kwargs["_reviewed_scope"])
        entered.set(); assert release.wait(3)
        return D.save_report(user, report(_check_request=kwargs["_request_receipt"]))
    monkeypatch.setattr(D, "run", fake_run)
    with ThreadPoolExecutor(1) as pool:
        first = pool.submit(W.run_reviewed, "owner", "system", expected_host_id="host", request_id="same")
        assert entered.wait(3)
        with pytest.raises(HTTPException) as e:
            W.run_reviewed("owner", "system", expected_host_id="host", request_id="same")
        assert e.value.status_code == 409
        release.set(); saved = first.result()
    W._requests.clear()  # A host restart loses in-memory request state.
    assert W.run_reviewed("owner", "system", expected_host_id="host", request_id="same")["id"] == saved["id"]
    assert len(calls) == 1
    with pytest.raises(HTTPException):
        W.run_reviewed("owner", "network", expected_host_id="host", request_id="same")


def test_read_failure_prevents_checks_and_failed_request_is_not_replayed(monkeypatch):
    calls = []
    monkeypatch.setattr(D, "run", lambda *a, **k: calls.append(1) or (_ for _ in ()).throw(RuntimeError("probe failed")))
    with pytest.raises(RuntimeError): W.run_reviewed("owner", "system", expected_host_id="host", request_id="once")
    with pytest.raises(HTTPException): W.run_reviewed("owner", "system", expected_host_id="host", request_id="once")
    assert calls == [1]
    monkeypatch.setattr(D, "history", lambda _: (_ for _ in ()).throw(HTTPException(503, "Missing key")))
    with pytest.raises(HTTPException): W.run_reviewed("owner", "system", expected_host_id="host", request_id="new")
    assert calls == [1]


def test_routes_require_auth_and_legacy_shape_stays_supported(monkeypatch):
    app = FastAPI(); app.include_router(router)
    with TestClient(app) as api:
        def denied(): raise HTTPException(401, "Locked")
        app.dependency_overrides[require_session] = denied
        assert api.get('/api/intelligence/diagnostics/options?computer_id=host').status_code == 401
        assert api.post('/api/intelligence/diagnostics', json={"kind": "system"}).status_code == 401
        app.dependency_overrides[require_session] = lambda: "owner"
        result = api.get('/api/intelligence/diagnostics/options?computer_id=host')
        assert result.json()["protocol"] == W.PROTOCOL and result.headers['cache-control'] == 'no-store'
        monkeypatch.setattr(D, "run", lambda *a, **k: report(kind="system"))
        assert api.post('/api/intelligence/diagnostics', json={"kind": "system"}).json()["kind"] == "system"
        assert api.post('/api/intelligence/diagnostics', json={"kind": "system", "request_id": "x"}).status_code == 422
