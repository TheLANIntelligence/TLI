"""Real PIN grants, exact auth delegation and bounded MCP wire; synthetic stores."""
import copy
import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from types import SimpleNamespace
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import mcp_bridge as B
import companion_auth as A
import tli_state as S
from routers import mcp_routes as R

@pytest.fixture(autouse=True)
def isolated(tmp_path,monkeypatch):
    monkeypatch.setattr(S,'DATA_DIR',str(tmp_path));monkeypatch.setattr(S,'_active_sessions',{})
    monkeypatch.setattr(S,'load_pin_config',lambda:{'enabled':True})
    monkeypatch.setattr(S,'read_node_config',lambda:SimpleNamespace(node_id='host-one',node_name='Fixture host'))
    monkeypatch.setattr(S,'MESH_DIRECTORY_PATH',tmp_path/'mesh.json');monkeypatch.setattr(S,'SHELLY_REGISTRY_PATH',tmp_path/'shelly.json')
    B.GRANTS.clear()
    yield
    B.GRANTS.clear()

@pytest.fixture
def api():
    app=FastAPI();app.include_router(R.router);app.middleware('http')(A.validate_authorization)
    for route in ['/status','/api/mcp/','/api/mcp-evil','/api/integrations/mcp/other']:
        app.add_api_route(route,lambda:{'public':True},methods=['GET','POST'])
    with TestClient(app,base_url='http://127.0.0.1:9876',client=('127.0.0.1',32123)) as client:
        token=S.create_session_token('fixture-owner');client.cookies.set('tli_session',token)
        client.browser_token=token
        yield client

def enabled(api,scopes=None):
    response=api.post('/api/integrations/mcp/grant',json={'scopes':scopes or ['registry','health','rooms'],'reviewed':True})
    assert response.status_code==200,response.text
    return response.json()

def wire(api,grant,method='tools/list',params=None,ident='request-one',headers=None):
    body={'jsonrpc':'2.0','id':ident,'method':method,'params':{'_meta':{R.PREFIX+'protocolVersion':B.PROTOCOL,R.PREFIX+'clientCapabilities':{}},**(params or {})}}
    h={'Authorization':'Bearer '+grant['credential'],'Accept':'application/json, text/event-stream','MCP-Protocol-Version':B.PROTOCOL,'Mcp-Method':method}
    if method=='tools/call':h['Mcp-Name']=params['name']
    h.update(headers or {})
    return api.post('/api/mcp',json=body,headers=h)

def test_navigation_status_and_discovery_do_not_read_private_or_operate(api,monkeypatch,tmp_path):
    monkeypatch.setattr(B,'call',lambda *a:pytest.fail('Discovery cannot invoke tools'))
    assert api.get('/api/integrations/mcp/status').json()['enabled'] is False
    grant=enabled(api,['health']);assert grant['credential'].startswith('tlim_')
    status=api.get('/api/integrations/mcp/status').json()
    assert status['enabled'] is True and grant['credential'] not in json.dumps(status)
    assert all('credential' not in row for row in status['grants'])
    assert not list(tmp_path.iterdir())
    result=wire(api,grant,'server/discover').json()['result'];assert result['resultType']=='complete' and result['supportedVersions']==[B.PROTOCOL]
    assert [t['name'] for t in wire(api,grant).json()['result']['tools']]==['tli_reported_health']
    assert api.post('/api/integrations/mcp/grant',json={'scopes':['rooms'],'reviewed':True}).status_code==409

@pytest.mark.parametrize('change',['expired','lock','PIN off','new owner','server restart','revoke'])
def test_grant_revocation_and_lifetime_cannot_fall_back_to_browser_or_local_mode(api,monkeypatch,change):
    g=enabled(api)
    if change=='expired':B.GRANTS[g['id']]['expires']=time.time()-1
    elif change=='lock':S.revoke_session_token(api.browser_token)
    elif change=='PIN off':monkeypatch.setattr(S,'load_pin_config',lambda:{'enabled':False})
    elif change=='new owner':S._active_sessions[api.browser_token]['user_id']='other-owner'
    elif change=='server restart':B.revoke_all_grants()
    else:assert api.post('/api/integrations/mcp/revoke',json={'id':g['id']}).json()['revoked'] is True
    assert wire(api,g).status_code==401

@pytest.mark.parametrize('path',['/status','/api/mcp/','/api/mcp-evil','/api/integrations/mcp/other'])
def test_only_exact_endpoint_delegates_mcp_bearer(api,path):
    g=enabled(api)
    assert api.get(path,headers={'Authorization':'Bearer '+g['credential']}).status_code==401
    assert api.get(path).status_code==200

@pytest.mark.parametrize('header,value',[('Host','evil.example:9876'),('Host','192.168.4.1:9876'),('Host','127.0.0.1:99999'),('Host','127.0.0.1:invalid'),('Origin','https://evil.example'),('Origin','null'),('X-Forwarded-For','127.0.0.1'),('Forwarded','for=127.0.0.1')])
def test_dns_rebinding_origin_and_proxy_headers_rejected(api,header,value):
    g=enabled(api);assert wire(api,g,headers={header:value}).status_code==403

def test_socket_peer_must_be_loopback_and_pin_required(monkeypatch):
    app=FastAPI();app.include_router(R.router)
    with TestClient(app,base_url='http://127.0.0.1',client=('192.168.4.4',42)) as client:
        client.cookies.set('tli_session',S.create_session_token('fixture'))
        assert client.get('/api/integrations/mcp/status').status_code==403
    with TestClient(app,base_url='http://localhost',client=('127.0.0.1',42)) as client:
        monkeypatch.setattr(S,'load_pin_config',lambda:{'enabled':False})
        assert client.get('/api/integrations/mcp/status').status_code==409

def test_credential_bound_to_exact_local_origin_and_management_browser(api):
    g=enabled(api)
    assert wire(api,g,headers={'Host':'localhost:9876'}).status_code==403
    assert api.post('/api/integrations/mcp/revoke',json={'id':g['id']},headers={'Authorization':'Bearer '+g['credential']}).status_code==401
    api.cookies.set('tli_session',S.create_session_token('another-owner'))
    assert api.post('/api/integrations/mcp/revoke',json={'id':g['id']}).status_code==404
    assert api.get('/api/integrations/mcp/status').json()['enabled'] is False

@pytest.mark.parametrize('headers',[{'Mcp-Method':'tools/call'},{'MCP-Protocol-Version':'2025-11-25'}])
def test_mirrored_header_mismatch_rejected_before_read(api,monkeypatch,headers):
    g=enabled(api);monkeypatch.setattr(B,'call',lambda *a:pytest.fail('No read'))
    response=wire(api,g,headers=headers);assert response.status_code==400 and response.json()['error']['code']==-32020

def test_modern_metadata_versions_request_ids_methods_and_bodies(api,monkeypatch):
    g=enabled(api);h={'Authorization':'Bearer '+g['credential'],'Accept':'application/json, text/event-stream','MCP-Protocol-Version':B.PROTOCOL,'Mcp-Method':'tools/list'}
    for data in [[],{'jsonrpc':'2.0','id':True,'method':'tools/list','params':{}},{'jsonrpc':'2.0','id':'x','method':'tools/list','params':{}}]:
        assert api.post('/api/mcp',json=data,headers=h).status_code==400
    assert api.post('/api/mcp',content='{"jsonrpc":"2.0","jsonrpc":"2.0"}',headers={**h,'Content-Type':'application/json'}).json()['error']['code']==-32700
    assert api.post('/api/mcp',content='x'*(B.MAX_BODY+1),headers={**h,'Content-Type':'application/json'}).status_code==413
    old={'_meta':{R.PREFIX+'protocolVersion':'2025-11-25',R.PREFIX+'clientCapabilities':{}}}
    response=wire(api,g,params=old,headers={'MCP-Protocol-Version':'2025-11-25'})
    assert response.json()['error']['code']==-32022 and response.json()['error']['data']['supported']==[B.PROTOCOL]
    assert wire(api,g,'initialize').status_code==400
    assert wire(api,g,'resources/read',{'uri':'file:///private'}).json()['error']['code']==-32601
    assert api.get('/api/mcp',headers=h).status_code==405

def test_registered_read_fields_and_rooms_never_expose_credentials_notes_or_probe(api,tmp_path,monkeypatch):
    (tmp_path/'home_power').mkdir();(tmp_path/'home_power'/'devices.json').write_text(json.dumps({'devices':[{'device_id':'lamp-one','name':'Studio lamp','ip':'192.168.4.5','relay':2,'room':'Studio','extra':{'password':'NEVER_EXPORT'},'notes':'PRIVATE_NOTE'}]}))
    before={str(p):p.read_bytes() for p in tmp_path.rglob('*') if p.is_file()}
    monkeypatch.setattr(S,'load_memory',lambda *a:pytest.fail('No note lookup'))
    monkeypatch.setattr(S.lm_provider,'complete',lambda **k:pytest.fail('No inference'))
    g=enabled(api,['registry','rooms'])
    for tool in ['tli_registered_devices','tli_recorded_rooms']:
        response=wire(api,g,'tools/call',{'name':tool,'arguments':{'limit':50}})
        assert response.status_code==200,response.text
        data=response.json()['result']['structuredContent'];assert data['actions_performed'] is data['inference_called'] is False
        assert any(row.get('room')=='Studio' for row in data['data']['items'])
        assert 'NEVER_EXPORT' not in response.text and 'PRIVATE_NOTE' not in response.text
    assert wire(api,g,'tools/call',{'name':'tli_reported_health','arguments':{}}).status_code==403
    assert before=={str(p):p.read_bytes() for p in tmp_path.rglob('*') if p.is_file()}

def test_health_missing_stale_failed_observations_are_distinct(api,monkeypatch):
    from routers import dashboard_presence as D
    g=enabled(api,['health'])
    for values,expected in [({'cpu_pct':None,'ram_pct':None,'probed_ts':0},'unknown'),({'cpu_pct':0,'ram_pct':40,'probed_ts':time.time()-40},'stale'),({'cpu_pct':12,'probed_ts':time.time(),'probe_error':'private exception'},'unavailable')]:
        monkeypatch.setattr(D,'_read_state',lambda:values)
        response=wire(api,g,'tools/call',{'name':'tli_reported_health','arguments':{}})
        data=response.json()['result']['structuredContent']['data']
        assert data['freshness']==expected and data['cpu_percent']==values['cpu_pct']
        assert data['ai_availability']=='unknown' and 'private exception' not in response.text

def test_duplicate_inflight_read_and_lock_during_read_reject_late_result(api,monkeypatch):
    g=enabled(api,['health']);started=Event();release=Event();calls=[]
    def slow(*args):calls.append(args);started.set();release.wait(3);return {'ok':True,'private':'LATE_PRIVATE'}
    monkeypatch.setattr(B,'call',slow)
    with ThreadPoolExecutor(2) as pool:
        future=pool.submit(wire,api,g,'tools/call',{'name':'tli_reported_health','arguments':{}},'same-id')
        assert started.wait(2)
        assert wire(api,g,'tools/call',{'name':'tli_reported_health','arguments':{}},'same-id').status_code==409
        S.revoke_session_token(api.browser_token);release.set();result=future.result(3)
    assert result.status_code==401 and 'LATE_PRIVATE' not in result.text and len(calls)==1

@pytest.mark.parametrize('scopes',[[],['health','health'],[{}],[['health']],['private_notes'],['registry','health','rooms','extra'],None])
def test_invalid_scopes_cannot_create_grant_or_raise_server_error(api,scopes):
    assert api.post('/api/integrations/mcp/grant',json={'scopes':scopes,'reviewed':True}).status_code==422
    assert not B.GRANTS

@pytest.mark.parametrize('arguments',[{'path':'C:/private'},{'offset':True},{'offset':-1},{'limit':51},{'limit':0},[]])
def test_fixed_read_arguments_are_bounded_before_any_source_read(api,monkeypatch,arguments):
    g=enabled(api,['registry']);monkeypatch.setattr(B,'_registry',lambda:pytest.fail('Invalid arguments cannot read a store'))
    response=wire(api,g,'tools/call',{'name':'tli_registered_devices','arguments':arguments})
    assert response.status_code==400 and response.json()['error']['code']==-32602

def test_request_rate_budget_and_global_worker_lease_cannot_be_bypassed(api):
    g=enabled(api,['health']);record=B.GRANTS[g['id']]
    record['requests']=[time.monotonic()]*60
    assert wire(api,g).status_code==429
    record['requests']=[]
    assert B._READ_SLOTS.acquire(False) and B._READ_SLOTS.acquire(False)
    try: assert wire(api,g,'tools/call',{'name':'tli_reported_health','arguments':{}}).status_code==429
    finally:B._READ_SLOTS.release();B._READ_SLOTS.release()

def test_tool_discovery_has_private_immediately_stale_cache_policy(api):
    g=enabled(api,['health']);result=wire(api,g).json()['result']
    assert result['cacheScope']=='private' and result['ttlMs']==0
