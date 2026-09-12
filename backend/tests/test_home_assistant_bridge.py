"""Synthetic Home Assistant contract, authority, targeting and preservation."""
import copy
import json
import socket
import ssl
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import pytest
from fastapi import FastAPI,HTTPException
from fastapi.testclient import TestClient
import tli_state as S
import home_assistant_bridge as H
from routers.home_assistant_routes import router

TOKEN='synthetic-long-lived-HA-token'
STATE={'entity_id':'light.desk','state':'off','attributes':{'friendly_name':'Desk lamp','secret_url':'https://private.example/NEVER','latitude':1},'last_changed':'2026-09-08T12:00:00Z','last_updated':'2026-09-08T12:00:00Z'}
@pytest.fixture(autouse=True)
def isolated(monkeypatch,tmp_path):
    monkeypatch.setattr(S,'DATA_DIR',str(tmp_path));monkeypatch.setattr(S,'_active_sessions',{});monkeypatch.setattr(S,'load_pin_config',lambda:{'enabled':True})
    monkeypatch.setattr(H.device_commands,'_requests',{});monkeypatch.setattr(H.device_commands,'_running',set())
    H.revoke_all_connections();H.BUSY.clear()
    yield
    H.revoke_all_connections();H.BUSY.clear()
@pytest.fixture
def api():
    app=FastAPI();app.include_router(router)
    with TestClient(app,base_url='https://tli.test:8000',client=('192.168.4.2',5000)) as client:
        client.browser=S.create_session_token('owner');client.cookies.set('tli_session',client.browser);yield client
def post(api,operation,data):return api.post('/api/integrations/home-assistant/'+operation,json=data)
@pytest.fixture
def remote(monkeypatch):
    calls=[];state=copy.deepcopy(STATE)
    def request(connection,method,path,body=None,check=None):
        if check:check()
        calls.append((method,path,body))
        if path=='/api/':return {'message':'API running.'}
        if path=='/api/states':return [copy.deepcopy(state),{'entity_id':'person.private','state':'home','attributes':{'secret':'NEVER'}}]
        if method=='GET':return copy.deepcopy(state)
        return []
    monkeypatch.setattr(H,'request_json',request)
    return calls,state
def connected(api):
    review=post(api,'connection-review',{'origin':'http://192.168.4.9:8123','allow_insecure_http':True})
    assert review.status_code==200,review.text
    response=post(api,'connect',{'review_token':review.json()['review_token'],'token':TOKEN})
    assert response.status_code==200,response.text
    return response.json()['connection']
def reviewed(api,connection):
    r=post(api,'action-review',{'connection_id':connection['id'],'entity_id':'light.desk','action':'turn_on'})
    assert r.status_code==200,r.text
    return {'connection_id':connection['id'],'review_token':r.json()['review_token'],'review_hash':r.json()['review_hash'],'request_id':'a'*32,'reviewed':True}
def test_connect_review_states_action_are_separate_and_persistence_unchanged(api,remote,tmp_path):
    calls,_=remote;assert api.get('/api/integrations/home-assistant/status').json()['connected'] is False;assert not calls
    c=connected(api);assert calls==[('GET','/api/',None)]
    result=post(api,'states',{'connection_id':c['id']});assert result.status_code==200
    assert len(result.json()['items'])==1 and result.json()['omitted_entities']==1
    assert 'NEVER' not in result.text and 'latitude' not in result.text and TOKEN not in result.text
    action=reviewed(api,c);assert not any(method=='POST' for method,_,_ in calls)
    first=post(api,'execute',action);assert first.json()['outcome']=='accepted' and first.json()['physical_confirmation'] is False
    repeated=post(api,'execute',action).json()
    assert repeated['outcome']==first.json()['outcome'] and repeated['request_id']==first.json()['request_id']
    assert [call for call in calls if call[0]=='POST']==[('POST','/api/services/light/turn_on',{'entity_id':'light.desk'})]
    assert not list(tmp_path.iterdir())
def test_state_change_duplicate_names_unknown_and_wrong_identity_never_retarget(api,remote):
    calls,state=remote;c=connected(api);review=reviewed(api,c);state['attributes']['friendly_name']='Different target'
    r=post(api,'execute',review);assert r.json()['requires_review'] is True and r.json()['actions_performed'] is False
    assert not any(m=='POST' for m,_,_ in calls)
    state['state']='unavailable';assert post(api,'action-review',{'connection_id':c['id'],'entity_id':'light.desk','action':'turn_on'}).status_code==409
    state['state']='off';state['entity_id']='light.other';assert post(api,'action-review',{'connection_id':c['id'],'entity_id':'light.desk','action':'turn_on'}).status_code==502
@pytest.mark.parametrize('entity,action',[('script.secret','turn_on'),('light.desk','toggle'),('light.desk,light.other','turn_on'),('light.desk/../../api','turn_off'),('light.desk','delete')])
def test_arbitrary_service_paths_and_multi_targets_refused(api,remote,entity,action):
    c=connected(api);before=len(remote[0]);assert post(api,'action-review',{'connection_id':c['id'],'entity_id':entity,'action':action}).status_code==422;assert len(remote[0])==before
@pytest.mark.parametrize('change',['expiry','lock','pin disabled','other owner','restart','disconnect'])
def test_session_and_connection_revocation_prevent_late_actions(api,remote,monkeypatch,change):
    calls,_=remote;c=connected(api);review=reviewed(api,c)
    if change=='expiry':H.CONNECTIONS[c['id']]['expires']=time.time()-1
    elif change=='lock':S.revoke_session_token(api.browser)
    elif change=='pin disabled':monkeypatch.setattr(S,'load_pin_config',lambda:{'enabled':False})
    elif change=='other owner':api.cookies.set('tli_session',S.create_session_token('other'))
    elif change=='restart':H.revoke_all_connections()
    else:assert post(api,'disconnect',{'connection_id':c['id']}).json()['disconnected'] is True
    assert post(api,'execute',review).status_code in (401,409);assert not any(m=='POST' for m,_,_ in calls)
def test_uncertain_service_is_not_replayed_and_new_request_cannot_reuse_review(api,remote,monkeypatch):
    c=connected(api);review=reviewed(api,c);original=H.request_json;attempts=[]
    def uncertain(v,m,p,b=None,check=None):
        if m=='POST':attempts.append(p);raise OSError('synthetic dropped response')
        return original(v,m,p,b,check)
    monkeypatch.setattr(H,'request_json',uncertain)
    assert post(api,'execute',review).json()['outcome']=='unknown'
    assert post(api,'execute',review).json()['outcome']=='unknown'
    assert post(api,'execute',{**review,'request_id':'b'*32}).status_code==409;assert len(attempts)==1
def test_failed_replacement_retains_previous_connection(api,remote,monkeypatch):
    c=connected(api);r=post(api,'connection-review',{'origin':'https://192.168.4.8:8123','allow_insecure_http':False}).json()
    monkeypatch.setattr(H,'request_json',lambda *a,**k:(_ for _ in ()).throw(HTTPException(502,'Candidate failed')))
    assert post(api,'connect',{'review_token':r['review_token'],'token':TOKEN}).status_code==502
    assert api.get('/api/integrations/home-assistant/status').json()['connections'][0]['id']==c['id']
def test_disconnect_during_pending_connection_invalidates_late_success(api,remote,monkeypatch):
    c=connected(api);r=post(api,'connection-review',{'origin':'https://192.168.4.8:8123','allow_insecure_http':False}).json();started=threading.Event();release=threading.Event()
    def delayed(*a,**k):started.set();release.wait(3);return {'message':'API running.'}
    monkeypatch.setattr(H,'request_json',delayed)
    with ThreadPoolExecutor(2) as pool:
        pending=pool.submit(post,api,'connect',{'review_token':r['review_token'],'token':TOKEN});assert started.wait(2)
        assert post(api,'disconnect',{'connection_id':c['id']}).status_code==200;release.set();assert pending.result().status_code==409
    assert not H.CONNECTIONS
@pytest.mark.parametrize('url',['https://example.com/path','https://user:pass@192.168.4.1','http://169.254.169.254','http://8.8.8.8','http://0.0.0.0','http://[fe80::1]','file:///tmp','http://192.168.4.1#fragment','http://192.168.4.1?secret=yes','http://127.0.0.1:8000'])
def test_bad_origins_send_no_credential(api,remote,url):
    assert post(api,'connection-review',{'origin':url,'allow_insecure_http':True}).status_code==422;assert not remote[0]
def test_dns_private_set_must_be_stable_before_token_send(api,monkeypatch):
    monkeypatch.setattr(H.socket,'getaddrinfo',lambda *a,**k:[(socket.AF_INET,socket.SOCK_STREAM,0,'',('192.168.4.10',0))])
    r=post(api,'connection-review',{'origin':'https://ha.example:8123','allow_insecure_http':False}).json()
    monkeypatch.setattr(H.socket,'getaddrinfo',lambda *a,**k:[(socket.AF_INET,socket.SOCK_STREAM,0,'',('192.168.4.11',0))])
    monkeypatch.setattr(H.socket,'create_connection',lambda *a,**k:pytest.fail('A changed destination must never receive the token'))
    assert post(api,'connect',{'review_token':r['review_token'],'token':TOKEN}).status_code==409
def test_mixed_public_dns_and_http_without_review_are_rejected(api,monkeypatch):
    monkeypatch.setattr(H.socket,'getaddrinfo',lambda *a,**k:[(socket.AF_INET,socket.SOCK_STREAM,0,'',('192.168.4.10',0)),(socket.AF_INET,socket.SOCK_STREAM,0,'',('8.8.8.8',0))])
    assert post(api,'connection-review',{'origin':'https://ha.example:8123','allow_insecure_http':False}).status_code==422
    assert post(api,'connection-review',{'origin':'http://192.168.4.9:8123','allow_insecure_http':False}).status_code==422
def test_unencrypted_lan_browser_and_cross_origin_do_not_receive_credentials(monkeypatch):
    app=FastAPI();app.include_router(router)
    with TestClient(app,base_url='http://192.168.4.5:8000',client=('192.168.4.2',32)) as c:
        c.cookies.set('tli_session',S.create_session_token('owner'));assert c.get('/api/integrations/home-assistant/status').status_code==403
    with TestClient(app,base_url='https://tli.test:8000') as c:
        c.cookies.set('tli_session',S.create_session_token('owner'));assert c.get('/api/integrations/home-assistant/status',headers={'Origin':'https://evil.example'}).status_code==403
def test_real_owned_loopback_transport_pins_origin_and_does_not_follow_redirects():
    calls=[]
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_GET(self):
            calls.append((self.path,self.headers.get('Authorization')))
            if self.path=='/redirect':self.send_response(302);self.send_header('Location','http://8.8.8.8/steal');self.end_headers();return
            data=b'{"message":"API running."}';self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    value={'host':'127.0.0.1','port':server.server_port,'addresses':('127.0.0.1',),'scheme':'http','token':TOKEN}
    try:
        assert H.request_json(value,'GET','/api/')['message']=='API running.'
        with pytest.raises(HTTPException) as exc:H.request_json(value,'GET','/redirect')
        assert exc.value.status_code==502 and 'Redirects' in exc.value.detail
        assert calls==[('/api/','Bearer '+TOKEN),('/redirect','Bearer '+TOKEN)]
    finally:server.shutdown();server.server_close();thread.join(2)

def test_pending_action_blocks_duplicates_replacement_and_never_replays(api,remote,monkeypatch):
    c=connected(api);review=reviewed(api,c);origin_review=post(api,'connection-review',{'origin':'http://192.168.4.8:8123','allow_insecure_http':True}).json()
    original=H.request_json;started=threading.Event();release=threading.Event();attempts=[]
    def delayed(v,m,p,b=None,check=None):
        if m=='POST':attempts.append(p);started.set();release.wait(3);return []
        return original(v,m,p,b,check)
    monkeypatch.setattr(H,'request_json',delayed)
    with ThreadPoolExecutor(2) as pool:
        pending=pool.submit(post,api,'execute',review);assert started.wait(2)
        assert post(api,'execute',review).status_code==409
        assert post(api,'connect',{'review_token':origin_review['review_token'],'token':TOKEN}).status_code==409
        release.set();first=pending.result().json()
    assert post(api,'execute',review).json()==first;assert len(attempts)==1

def test_preflight_read_failure_is_definitely_not_a_service_submission(api,remote,monkeypatch):
    c=connected(api);review=reviewed(api,c)
    monkeypatch.setattr(H,'request_json',lambda *a,**k:(_ for _ in ()).throw(OSError('read failed')))
    result=post(api,'execute',review).json()
    assert result['outcome']=='failed' and result['actions_performed'] is False

@pytest.mark.parametrize('field,value',[('connection_id',[]),('review_token',{}),('request_id',False),('reviewed','yes')])
def test_malformed_action_fields_fail_before_lookups(api,field,value):
    data={'connection_id':'a'*32,'review_token':'b'*64,'review_hash':'c'*64,'request_id':'d'*32,'reviewed':True};data[field]=value
    assert post(api,'execute',data).status_code==422

@pytest.mark.parametrize('mode',['oversized','encoded','duplicate','slow','html'])
def test_real_transport_bounds_and_timeout_never_reconnect(monkeypatch,mode):
    calls=[]
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_GET(self):
            calls.append(self.path);self.send_response(200)
            self.send_header('Content-Type','text/html' if mode=='html' else 'application/json')
            if mode=='oversized':self.send_header('Content-Length',str(H.MAX_RESPONSE+1))
            if mode=='encoded':self.send_header('Content-Encoding','gzip')
            self.end_headers()
            if mode=='slow':time.sleep(.2)
            try:self.wfile.write(b'{"same":1,"same":2}' if mode=='duplicate' else b'{}')
            except OSError:pass
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    if mode=='slow':monkeypatch.setattr(H,'REQUEST_TIMEOUT',.06)
    value={'host':'127.0.0.1','port':server.server_port,'addresses':('127.0.0.1',),'scheme':'http','token':TOKEN}
    try:
        with pytest.raises(HTTPException) as exc:H.request_json(value,'GET','/api/states')
        assert exc.value.status_code==502;assert calls==['/api/states']
    finally:server.shutdown();server.server_close();thread.join(2)

def test_verified_https_uses_pinned_tcp_and_original_hostname_without_token_on_bad_cert(tmp_path,monkeypatch):
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    from cryptography.hazmat.primitives import hashes,serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from datetime import datetime,timedelta,timezone
    key=rsa.generate_private_key(public_exponent=65537,key_size=2048);name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'ha.fixture')]);now=datetime.now(timezone.utc)
    cert=x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=1)).not_valid_after(now+timedelta(days=1)).add_extension(x509.SubjectAlternativeName([x509.DNSName('ha.fixture')]),critical=False).sign(key,hashes.SHA256())
    cert_path=tmp_path/'synthetic.pem';key_path=tmp_path/'synthetic.key';cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM));key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
    calls=[]
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_GET(self):
            calls.append((self.headers.get('Host'),self.headers.get('Authorization')));data=b'{"message":"API running."}';self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler);context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(cert_path,key_path);server.socket=context.wrap_socket(server.socket,server_side=True);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    monkeypatch.setattr(H,'resolve',lambda _:('127.0.0.1',));value={'host':'ha.fixture','port':server.server_port,'addresses':('127.0.0.1',),'scheme':'https','token':TOKEN}
    try:
        with pytest.raises(HTTPException):H.request_json(value,'GET','/api/')
        assert calls==[],'An untrusted certificate must not receive the Bearer token'
        original=ssl.create_default_context;monkeypatch.setattr(H.ssl,'create_default_context',lambda:original(cafile=str(cert_path)))
        assert H.request_json(value,'GET','/api/')['message']=='API running.'
        assert calls==[(f'ha.fixture:{server.server_port}','Bearer '+TOKEN)]
        with pytest.raises(HTTPException):H.request_json({**value,'host':'wrong.fixture'},'GET','/api/')
        assert len(calls)==1,'Hostname mismatch must not receive a credential even at the same pinned IP'
    finally:server.shutdown();server.server_close();thread.join(2)

def test_owner_change_during_candidate_cannot_publish_old_account_connection(api,remote,monkeypatch):
    review=post(api,'connection-review',{'origin':'http://192.168.4.9:8123','allow_insecure_http':True}).json()
    def changed(*a,**k):S._active_sessions[api.browser]['user_id']='new-owner';return {'message':'API running.'}
    monkeypatch.setattr(H,'request_json',changed)
    assert post(api,'connect',{'review_token':review['review_token'],'token':TOKEN}).status_code==401
    assert not H.CONNECTIONS
