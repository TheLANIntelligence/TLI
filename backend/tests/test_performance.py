"""Synthetic bounded process observations; no host sampling or inference."""
import copy
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import tli_state as S
from intelligence import performance as P, diagnostics
from intelligence.store import private_path
from routers import performance_routes as R
from routers.system_routes import require_session


def test_existing_game_routes_require_session_before_detection_or_inference(monkeypatch):
    from routers.games import games_router
    app = FastAPI(); app.include_router(games_router)
    app.dependency_overrides[require_session] = lambda: (_ for _ in ()).throw(HTTPException(401, 'Locked'))
    with TestClient(app) as client:
        for method, path in [('get','/games/detect_best'),('get','/games/detect_filtered'),('get','/games/supported'),('post','/games/config_read'),('post','/games/ask'),('post','/games/recommend')]:
            assert getattr(client, method)(path, **({'json': {}} if method == 'post' else {})).status_code == 401


def test_game_reader_keeps_three_exact_adapter_targets():
    from game_configs.registry import find_adapter, list_supported_games
    assert len(list_supported_games()) == 3
    for name in ['Cyberpunk 2077', 'the witcher 3', 'RDR2']:
        assert find_adapter(name) is not None
    for name in ['r', 'red', 'witch', 'Cyberpunk 2077 modded other game', '']:
        assert find_adapter(name) is None


def test_game_offline_and_partial_stream_are_explicit_without_live_ai(monkeypatch):
    import asyncio
    from routers import games as G
    from intelligence import read_only_inference as I
    class Binding:
        def public(self): return {"provider":"bundled","model":"fixture"}
    monkeypatch.setattr(I, 'prepare', lambda *args, **kw: (Binding(), {}))
    def unavailable(*args, **kwargs):
        raise HTTPException(503, 'AI unavailable')
        yield
    monkeypatch.setattr(I, 'stream', unavailable)
    async def collect(response):
        return ''.join([part async for part in response.body_iterator])
    payload = {'game_name':'Cyberpunk 2077','corrections':{'gpu':'Fixture GPU','resolution':'1920x1080'}}
    offline = asyncio.run(collect(G.games_ask(payload)))
    assert 'AI unavailable' in offline and '"incomplete": true' in offline
    assert 'static-guidance' not in offline
    def partial(*args, **kwargs):
        yield 'Partial synthetic advice'
        raise HTTPException(502, 'Incomplete stream')
    monkeypatch.setattr(I, 'stream', partial)
    output = asyncio.run(collect(G.games_ask(payload)))
    assert 'Partial synthetic advice' not in output and '"incomplete": true' in output
    assert 'static-guidance' not in output


OWNER = 'performance-fixture-owner'
PROCESS = {'pid': 77, 'create_time': 1200.0, 'name': 'Synthetic editor', 'exe': 'C:\\Fixture\\editor.exe'}
VALUES = dict(zip(P.METRICS, [25.0, 50.0, 4_000_000, 8_000_000, 12.5, 1_000_000]))


class FakeProbe:
    def __init__(self, selected): self.selected = selected
    def sample(self): return dict(VALUES)


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(S, 'DATA_DIR', str(tmp_path))
    monkeypatch.setattr(P.devices, 'node', lambda: {'id': 'host-one', 'name': 'Synthetic host', 'role': 'standalone'})
    monkeypatch.setattr(P, 'identity', lambda pid: (None, {**PROCESS, 'pid': pid}))
    for name in ['cpu_percent', 'cpu_count', 'virtual_memory', 'pids', 'Process']:
        monkeypatch.setattr(P.psutil, name, lambda *args, **kwargs: pytest.fail('No real resource calls in tests'))
    manager = P.Observations(probe_factory=FakeProbe, duration=.03, interval=.01)
    monkeypatch.setattr(P, 'manager', manager)
    yield manager
    for row in manager.rows.values(): row['stop'].set()


def finished(manager, ident):
    until = time.monotonic() + 2
    while time.monotonic() < until:
        value = manager.get(OWNER, ident)
        if value['status'] != 'running': return value
        time.sleep(.005)
    pytest.fail('Synthetic observation did not finish')


def start(manager, request='start-1', pid=77, created=1200.0):
    return manager.start(OWNER, request, pid, created)[0]


def test_no_sampling_on_capabilities_and_owned_routes_require_auth():
    app = FastAPI(); app.include_router(R.router)
    app.dependency_overrides[require_session] = lambda: (_ for _ in ()).throw(HTTPException(401, 'Locked'))
    with TestClient(app) as client:
        for method, path, body in [('get','/capabilities',None),('get','/processes',None),('post','/observations',{'request_id':'x','pid':77,'create_time':1200.0})]:
            response = getattr(client, method)('/api/intelligence/performance'+path, **({'json':body} if body else {}))
            assert response.status_code == 401
    app.dependency_overrides[require_session] = lambda: OWNER
    with TestClient(app) as client:
        response = client.get('/api/intelligence/performance/capabilities')
        assert response.status_code == 200 and response.json()['duration_seconds'] == 30
        assert response.headers['cache-control'] == 'no-store'


def test_completed_values_and_no_persistence_until_explicit_save(isolated):
    row = finished(isolated, start(isolated)['id'])
    assert row['status'] == 'completed' and row['sample_count'] == 3
    assert row['summary']['process_cpu_percent'] == {'min':12.5,'max':12.5,'mean':12.5,'samples':3}
    assert diagnostics.history(OWNER) == []
    saved = isolated.save(OWNER, row['id'], 'save-one')
    assert saved['kind'] == 'performance' and saved['performance']['process']['pid'] == 77
    assert len(diagnostics.history(OWNER)) == 1
    assert 'Synthetic editor' not in private_path(OWNER, 'diagnostics').read_text()
    assert all(check['status'] == 'pass' for check in saved['checks'])


def test_duplicate_start_and_save_serialize_and_keep_immutable_report(isolated):
    with ThreadPoolExecutor(8) as pool:
        rows = list(pool.map(lambda _: isolated.start(OWNER, 'same', 77, 1200.0), range(8)))
    assert len({row[0]['id'] for row in rows}) == 1
    assert sum(not row[1] for row in rows) == 1
    ident = rows[0][0]['id']; finished(isolated, ident)
    with ThreadPoolExecutor(8) as pool:
        reports = list(pool.map(lambda _: isolated.save(OWNER, ident, 'same-save'), range(8)))
    assert all(report == reports[0] for report in reports)
    assert len(diagnostics.history(OWNER)) == 1
    assert isolated.by_request(OWNER, 'same')['id'] == ident


def test_active_observation_blocks_other_owner_without_leaking_identity(isolated):
    row = start(isolated)
    with pytest.raises(HTTPException) as error: isolated.start('other', 'other', 55, 1200.0)
    assert error.value.status_code == 409 and '77' not in error.value.detail
    with pytest.raises(HTTPException): isolated.get('other', row['id'])
    with pytest.raises(HTTPException): isolated.stop('other', row['id'])
    with pytest.raises(HTTPException): isolated.save('other', row['id'], 'save')
    assert isolated.listing('other') == []
    with pytest.raises(HTTPException): isolated.by_request('other', 'start-1')


def test_reused_request_or_process_identity_rejected_before_worker(isolated):
    with pytest.raises(HTTPException) as error: start(isolated, created=1300.0)
    assert error.value.status_code == 409 and not isolated.rows
    start(isolated)
    with pytest.raises(HTTPException) as error: start(isolated, pid=88)
    assert error.value.status_code == 409


def test_stop_is_request_then_terminal_idempotent_and_keeps_samples(isolated):
    row = start(isolated)
    time.sleep(.016)
    stopping = isolated.stop(OWNER, row['id'])
    assert stopping['status'] in ('running','stopped')
    result = finished(isolated, row['id'])
    assert result['status'] == 'stopped' and 0 < result['sample_count'] < 3
    assert isolated.stop(OWNER, row['id']) == result
    report = isolated.save(OWNER, row['id'], 'stop-save')
    assert all(check['status'] == 'unavailable' for check in report['checks'])
    assert report['performance']['reason'] == 'stopped_by_user'


@pytest.mark.parametrize('reason',['process_exited','process_reused','process_identity_unavailable','process_executable_changed'])
def test_process_loss_keeps_partial_data_and_releases_host(reason, isolated):
    class Gone(FakeProbe):
        count=0
        def sample(self):
            self.count+=1
            if self.count == 2: raise P.ProcessChanged(reason)
            return dict(VALUES)
    isolated.probe_factory = Gone
    row = finished(isolated, start(isolated)['id'])
    assert row['status'] == 'partial' and row['reason'] == reason and row['sample_count'] == 1
    assert isolated.active is None


def test_missing_and_nonfinite_metrics_are_unknown_not_zero(isolated):
    class Missing(FakeProbe):
        def sample(self): return {**VALUES,'host_cpu_percent':None,'process_cpu_percent':float('nan'),'process_rss_bytes':-1}
    isolated.probe_factory = Missing
    row = finished(isolated, start(isolated)['id'])
    assert row['status'] == 'partial'
    assert row['summary']['host_cpu_percent']['mean'] is None
    assert row['summary']['process_cpu_percent']['samples'] == 0
    assert row['summary']['process_rss_bytes']['mean'] is None


def test_failed_replacement_save_preserves_existing_history_and_can_retry(isolated, monkeypatch):
    ident=finished(isolated,start(isolated)['id'])['id']
    original=diagnostics.save_report
    monkeypatch.setattr(diagnostics,'save_report',lambda *args,**kwargs: (_ for _ in ()).throw(HTTPException(503,'Synthetic write failure')))
    with pytest.raises(HTTPException): isolated.save(OWNER,ident,'save-one')
    assert diagnostics.history(OWNER)==[]
    frozen=copy.deepcopy(isolated.rows[ident]['report'])
    monkeypatch.setattr(diagnostics,'save_report',original)
    result=isolated.save(OWNER,ident,'save-one')
    assert result['created_at']==frozen['created_at'] and result['performance']==frozen['performance']


def test_ttl_and_cap_bound_unsaved_results(isolated):
    for index in range(23): finished(isolated,start(isolated,str(index))['id'])
    assert len(isolated.rows)==20
    now=time.monotonic()
    isolated.clock=lambda:now+601
    assert isolated.listing(OWNER)==[]


def test_comparison_requires_same_host_and_known_executable(isolated):
    row=finished(isolated,start(isolated)['id']); saved=isolated.save(OWNER,row['id'],'one')
    other={**row,'id':'second'}
    assert P.make_report(other,[saved])['comparison']['report_id']==saved['id']
    for changed in [{**other,'host':{'id':'other','name':'Other'}},{**other,'process':{**PROCESS,'exe':None}},{**other,'process':{**PROCESS,'exe':'C:\\Fixture\\other.exe'}}]:
        assert P.make_report(changed,[saved])['comparison'] is None


def test_process_picker_bounded_and_contains_no_command_lines(monkeypatch):
    calls=[]
    monkeypatch.setattr(P.psutil,'pids',lambda:list(range(1,2001)))
    def identify(pid): calls.append(pid); return None,{**PROCESS,'pid':pid}
    monkeypatch.setattr(P,'identity',identify)
    result=P.process_list('',10)
    assert len(calls)==1024 and len(result['processes'])==10 and result['coverage']['limited']
    assert all(set(row)=={'pid','create_time','name','exe'} for row in result['processes'])


def test_actual_probe_normalizes_process_cpu_and_detects_pid_reuse(monkeypatch):
    proc=SimpleNamespace(cpu_times=lambda:SimpleNamespace(user=2,system=0),memory_info=lambda:SimpleNamespace(rss=1024))
    monkeypatch.setattr(P,'identity',lambda pid:(proc,dict(PROCESS)))
    monkeypatch.setattr(P.psutil,'cpu_count',lambda **kwargs:8)
    monkeypatch.setattr(P.psutil,'cpu_percent',lambda **kwargs:55)
    monkeypatch.setattr(P.psutil,'virtual_memory',lambda:SimpleNamespace(percent=40,used=4,total=10))
    times=iter([1,2]);monkeypatch.setattr(P.time,'monotonic',lambda:next(times))
    probe=P.Probe(PROCESS)
    proc.cpu_times=lambda:SimpleNamespace(user=6,system=0)
    assert probe.sample()['process_cpu_percent']==50
    monkeypatch.setattr(P,'identity',lambda pid:(proc,{**PROCESS,'create_time':1300.0}))
    with pytest.raises(P.ProcessChanged) as error: probe.sample()
    assert error.value.reason=='process_reused'


def test_strict_route_rejects_unbounded_or_unknown_parameters(isolated):
    app=FastAPI();app.include_router(R.router);app.dependency_overrides[require_session]=lambda:OWNER
    with TestClient(app) as client:
        for body in [{'request_id':'x','pid':True,'create_time':1200.0},{'request_id':'x','pid':77,'create_time':1200.0,'duration':900},{'request_id':'x'*129,'pid':77,'create_time':1200.0}]:
            assert client.post('/api/intelligence/performance/observations',json=body).status_code==422
        assert not isolated.rows
