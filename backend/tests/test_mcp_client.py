"""Synthetic manual MCP client: no real service, credential, or user data."""
import copy
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import pytest
from fastapi import FastAPI,HTTPException
from fastapi.testclient import TestClient
import tli_state as S
import mcp_client as M
from routers.mcp_client_routes import router

TOOL={'name':'synthetic.echo','description':'Echo data; this is only a server claim.','inputSchema':{'type':'object','properties':{'text':{'type':'string','maxLength':1000,'x-mcp-header':'Text'}},'required':['text'],'additionalProperties':False},'annotations':{'readOnlyHint':True},'outputSchema':{'type':'object','properties':{'echo':{'type':'string'}},'required':['echo']}}
IDENTITY={'resultType':'complete','supportedVersions':[M.MCP_VERSION],'capabilities':{'tools':{}},'_meta':{'io.modelcontextprotocol/serverInfo':{'name':'Synthetic MCP','version':'1'}}}
@pytest.fixture(autouse=True)
def isolated(monkeypatch,tmp_path):
    monkeypatch.setattr(S,'DATA_DIR',str(tmp_path));monkeypatch.setattr(S,'_active_sessions',{});monkeypatch.setattr(S,'load_pin_config',lambda:{'enabled':True})
    M.revoke_all_connections();M.BUSY.clear();yield;M.revoke_all_connections();M.BUSY.clear()
@pytest.fixture
def api():
    app=FastAPI();app.include_router(router)
    with TestClient(app,base_url='https://tli.test:8000',client=('192.168.4.2',5000)) as client:
        client.browser=S.create_session_token('owner');client.cookies.set('tli_session',client.browser);yield client
def post(api,operation,data):return api.post('/api/integrations/mcp-client/'+operation,json=data)
@pytest.fixture
def remote(monkeypatch):
    calls=[];tool=copy.deepcopy(TOOL)
    def rpc(c,method,params,check,headers=None):
        check();calls.append((method,copy.deepcopy(params),copy.deepcopy(headers)))
        if method=='server/discover':return copy.deepcopy(IDENTITY)
        if method=='tools/list':return {'resultType':'complete','tools':[copy.deepcopy(tool)],'cacheScope':'private','ttlMs':0}
        return {'resultType':'complete','content':[{'type':'text','text':'<script>untrusted</script>'},{'type':'resource_link','uri':'https://never.test/private'}],'structuredContent':{'echo':params['arguments']['text']}}
    monkeypatch.setattr(M,'rpc',rpc);return calls,tool
def connected(api):
    review=post(api,'connection-review',{'endpoint':'http://127.0.0.1:8124/mcp'});assert review.status_code==200,review.text
    r=post(api,'connect',{'review_token':review.json()['review_token'],'token':'SYNTHETIC-EXTERNAL-TOKEN','reviewed':True});assert r.status_code==200,r.text
    return r.json()
def reviewed(api,c,args=None):
    r=post(api,'tool-review',{'connection_id':c['connection']['id'],'tool_name':TOOL['name'],'tool_fingerprint':c['tools'][0]['fingerprint'],'arguments':args or {'text':'hello'}});assert r.status_code==200,r.text
    return {'connection_id':c['connection']['id'],'review_token':r.json()['review_token'],'review_hash':r.json()['review_hash'],'request_id':'request_a'*4,'reviewed':True}
def test_navigation_review_connect_discovery_call_are_explicit_no_private_reads(api,remote,tmp_path):
    calls,_=remote;assert api.get('/api/integrations/mcp-client/status').json()['remote_requests'] is False;assert not calls
    c=connected(api);assert [x[0] for x in calls]==['server/discover','tools/list'];assert c['tool_invoked'] is False
    request=reviewed(api,c);assert all(x[0]!='tools/call' for x in calls)
    r=post(api,'invoke',request).json();assert r['outcome']=='completed' and r['actual_effect']=='unknown';assert r['output']['omitted_content_items']==1
    assert r['output']['text']==['<script>untrusted</script>'];assert 'never.test' not in json.dumps(r)
    assert post(api,'invoke',request).json()==r;assert len([x for x in calls if x[0]=='tools/call'])==1
    assert not list(tmp_path.iterdir()) and 'SYNTHETIC-EXTERNAL-TOKEN' not in json.dumps(c)
@pytest.mark.parametrize('url',['http://localhost:8124/mcp','http://192.168.4.9:8124/mcp','http://169.254.169.254:8124/mcp','http://example.com:8124/mcp','http://127.0.0.1:8000/mcp','http://127.0.0.1/mcp','http://127.0.0.1:8124/mcp/','http://127.0.0.1:8124/mcp?x=1','http://user:pass@127.0.0.1:8124/mcp','http://[::ffff:127.0.0.1]:8124/mcp','file:///mcp','http://127.1:8124/mcp','http://127.0.0.1:8124/other'])
def test_endpoint_is_literal_loopback_exact_path_and_other_port(api,remote,url):
    assert post(api,'connection-review',{'endpoint':url}).status_code==422;assert not remote[0]
@pytest.mark.parametrize('url',['http://127.0.0.1:8124/mcp','https://[::1]:9443/api/mcp'])
def test_endpoint_review_does_not_contact_remote(api,remote,url):
    r=post(api,'connection-review',{'endpoint':url});assert r.status_code==200 and r.json()['remote_requests'] is False;assert not remote[0]
@pytest.mark.parametrize('headers',[{'Authorization':'Bearer tlim_'+'x'*43},{'Authorization':'Bearer companion'},{'X-Forwarded-For':'127.0.0.1'},{'Origin':'https://evil.test'},{'Sec-Fetch-Site':'cross-site'}])
def test_management_rejects_other_auth_and_cross_origin(api,remote,headers):
    assert api.get('/api/integrations/mcp-client/status',headers=headers).status_code==403;assert not remote[0]
def test_pin_required_and_other_owner_cannot_read_or_invoke(api,remote,monkeypatch):
    c=connected(api);req=reviewed(api,c);api.cookies.set('tli_session',S.create_session_token('other'))
    assert post(api,'invoke',req).status_code==404
    monkeypatch.setattr(S,'load_pin_config',lambda:{'enabled':False});assert api.get('/api/integrations/mcp-client/status').status_code==409
@pytest.mark.parametrize('change',['schema','annotation','identity','target'])
def test_review_change_never_invokes_and_cannot_reuse_consumed_review(api,remote,monkeypatch,change):
    c=connected(api);req=reviewed(api,c)
    if change=='schema':remote[1]['inputSchema']['required']=[]
    elif change=='annotation':remote[1]['annotations']['readOnlyHint']=False
    elif change=='target':remote[1]['name']='synthetic.other'
    else:
        original=M.rpc
        def rpc(*args,**kwargs):
            result=original(*args,**kwargs)
            if args[1]=='server/discover':result['_meta']['io.modelcontextprotocol/serverInfo']['version']='2'
            return result
        monkeypatch.setattr(M,'rpc',rpc)
    r=post(api,'invoke',req);assert r.json()['outcome']=='not_sent';assert not any(x[0]=='tools/call' for x in remote[0])
    assert post(api,'invoke',{**req,'request_id':'different_request_1'}).status_code==409
def test_invalid_args_unsupported_schema_do_not_invoke(api,remote):
    c=connected(api);r=post(api,'tool-review',{'connection_id':c['connection']['id'],'tool_name':TOOL['name'],'tool_fingerprint':c['tools'][0]['fingerprint'],'arguments':{'text':1}});assert r.status_code==422
    remote[1]['inputSchema']['properties']['text']['pattern']='(a+)+$'
    listed=post(api,'list',{'connection_id':c['connection']['id']}).json();assert listed['tools'][0]['supported'] is False
    assert not any(x[0]=='tools/call' for x in remote[0])
@pytest.mark.parametrize('keyword,value',[('$ref','https://never.test/schema'),('$defs',{}),('pattern','.*'),('format','uri'),('x-mcp-header','Bad\r\nHeader')])
def test_unsupported_schema_not_silently_ignored(keyword,value):
    schema={'type':'object',keyword:value}
    with pytest.raises(ValueError):M.schema_check(schema)
def test_schema_nested_arguments_and_mirrored_headers():
    s={'type':'object','properties':{'n':{'type':'integer','x-mcp-header':'N'},'label':{'type':'string','x-mcp-header':'Label'},'v':{'anyOf':[{'type':'null'},{'type':'array','items':{'type':'integer'},'maxItems':3}]}},'required':['n','label'],'additionalProperties':False}
    paths=M.schema_check(s);assert M.schema_matches({'n':3,'label':' 世界\n','v':[1,2]},s)
    assert not M.schema_matches({'n':True,'label':'ok'},s)
    assert not M.schema_matches({'n':3,'label':'ok','v':[1,2,3,4]},s)
    headers=M.argument_headers({'n':3,'label':' 世界\n'},paths);assert headers['Mcp-Param-N']=='3' and headers['Mcp-Param-Label'].startswith('=?base64?')
    with pytest.raises(HTTPException):M.argument_headers({'n':2**54,'label':'ok'},paths)
    with pytest.raises(HTTPException):M.argument_headers({'n':1e20,'label':'ok'},paths)
    assert M.argument_headers({'n':1.0,'label':'ok'},paths)['Mcp-Param-N']=='1'
def test_duplicate_headers_or_nonstatic_header_rejected():
    for s in [{'type':'object','properties':{'a':{'type':'string','x-mcp-header':'A'},'b':{'type':'string','x-mcp-header':'a'}}},{'type':'array','items':{'type':'string','x-mcp-header':'Item'}}]:
        with pytest.raises(ValueError):M.schema_check(s)
@pytest.mark.parametrize('bound',['minimum','maximum','exclusiveMinimum','exclusiveMaximum'])
def test_large_valid_integer_schema_bounds_do_not_overflow_catalogue(api,remote,bound):
    remote[1]['inputSchema']['properties']['n']={'type':'number',bound:10**400}
    c=connected(api);assert c['tools'][0]['supported'] is True
def test_expiry_cleanup_removes_token_and_reviews_without_any_later_request(api,remote,monkeypatch):
    timers=[]
    class Timer:
        def __init__(self,delay,fn):self.delay=delay;self.fn=fn;self.cancelled=False;timers.append(self)
        def start(self):pass
        def cancel(self):self.cancelled=True
    monkeypatch.setattr(M.threading,'Timer',Timer)
    c=connected(api);reviewed(api,c);assert M.CONNECTIONS and M.REVIEWS
    monkeypatch.setattr(M.time,'time',lambda:10**12);active=timers[-1];count=len(remote[0]);active.fn()
    assert not M.CONNECTIONS and not M.REVIEWS and not M.ENDPOINTS and len(remote[0])==count
def test_unpaired_unicode_json_rejected_explicitly(api):
    r=api.post('/api/integrations/mcp-client/connection-review',content=b'{"endpoint":"\\ud800"}',headers={'Content-Type':'application/json'});assert r.status_code==400
@pytest.mark.parametrize('event',['lock','expiry','owner','disconnect'])
def test_authority_changes_drop_late_result_no_private_reappearance(api,remote,monkeypatch,event):
    c=connected(api);req=reviewed(api,c);original=M.rpc
    def rpc(*a,**kw):
        out=original(*a,**kw)
        if a[1]=='tools/call':
            if event=='lock':M.revoke_browser_session(api.browser)
            elif event=='expiry':a[0]['expires']=0
            elif event=='owner':monkeypatch.setattr(S,'get_session_user_id',lambda _: 'different')
            else:M.disconnect(type('R',(),{})(),{}) if False else M.revoke_all_connections()
        return out
    monkeypatch.setattr(M,'rpc',rpc);r=post(api,'invoke',req);assert r.status_code==409 and 'untrusted' not in r.text
def test_uncertain_call_is_not_replayed_and_duplicate_id_binding(api,remote,monkeypatch):
    c=connected(api);req=reviewed(api,c);original=M.rpc
    def rpc(*a,**kw):
        if a[1]=='tools/call':remote[0].append(('tools/call',{},{}));raise HTTPException(504,'Synthetic lost response')
        return original(*a,**kw)
    monkeypatch.setattr(M,'rpc',rpc);r=post(api,'invoke',req);assert r.json()['outcome']=='unknown'
    assert post(api,'invoke',req).json()==r.json();assert len([x for x in remote[0] if x[0]=='tools/call'])==1
    assert post(api,'invoke',{**req,'review_hash':'bad'}).status_code==409
def test_duplicate_pending_call_and_competing_list_are_busy(api,remote,monkeypatch):
    c=connected(api);req=reviewed(api,c);original=M.rpc;entered=threading.Event();done=threading.Event()
    def rpc(*a,**kw):
        if a[1]=='tools/call':entered.set();assert done.wait(3)
        return original(*a,**kw)
    monkeypatch.setattr(M,'rpc',rpc)
    with ThreadPoolExecutor(2) as pool:
        task=pool.submit(post,api,'invoke',req);assert entered.wait(3)
        assert post(api,'invoke',req).status_code==409
        assert post(api,'list',{'connection_id':c['connection']['id']}).status_code==409
        done.set();assert task.result().json()['outcome']=='completed'
    assert len([x for x in remote[0] if x[0]=='tools/call'])==1
def test_failed_replacement_and_disconnect_pending_candidate_preserve_identity(api,remote,monkeypatch):
    c=connected(api);original=M.rpc
    def fail(*a,**kw):raise HTTPException(502,'candidate unavailable')
    monkeypatch.setattr(M,'rpc',fail)
    review=post(api,'connection-review',{'endpoint':'http://127.0.0.1:9001/mcp'}).json()
    assert post(api,'connect',{'review_token':review['review_token'],'token':'new-token','reviewed':True}).status_code==502
    assert api.get('/api/integrations/mcp-client/status').json()['connections'][0]['id']==c['connection']['id']
    def late(*a,**kw):
        result=original(*a,**kw);M.revoke_browser_session(api.browser);return result
    monkeypatch.setattr(M,'rpc',late)
    review=post(api,'connection-review',{'endpoint':'http://127.0.0.1:9001/mcp'}).json()
    assert post(api,'connect',{'review_token':review['review_token'],'token':'new-token','reviewed':True}).status_code==409
    assert api.get('/api/integrations/mcp-client/status').json()['connected'] is False
def test_catalogue_overflow_duplicate_and_bad_protocol_leave_old_connection(api,remote,monkeypatch):
    c=connected(api);original=M.rpc
    for mode in ('count','duplicate','protocol'):
        def broken(*a,**kw):
            out=original(*a,**kw)
            if mode=='protocol' and a[1]=='server/discover':out['supportedVersions']=['2025-11-25']
            if a[1]=='tools/list':out['tools']=[copy.deepcopy(TOOL)]*(65 if mode=='count' else 2)
            return out
        monkeypatch.setattr(M,'rpc',broken);r=post(api,'list',{'connection_id':c['connection']['id']});assert r.status_code in (409,502)
        assert M.CONNECTIONS[c['connection']['id']]['tools']==c['tools']

@pytest.fixture
def server():
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            raw=self.rfile.read(int(self.headers['Content-Length']));self.server.calls.append((self.path,dict(self.headers),M.strict_json(raw)))
            self.server.respond(self,M.strict_json(raw))
        def log_message(self,*a):pass
    http=ThreadingHTTPServer(('127.0.0.1',0),Handler);http.calls=[];thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start();yield http
    http.shutdown();http.server_close();thread.join(3)
def connection(server):return {'host':'127.0.0.1','port':server.server_port,'path':'/mcp','scheme':'http','token':'synthetic-remote-token'}
def respond(handler,body,kind='application/json',status=200,extra=None):
    raw=body if isinstance(body,bytes) else json.dumps(body).encode();handler.send_response(status);handler.send_header('Content-Type',kind);handler.send_header('Content-Length',str(len(raw)))
    for key,value in (extra or {}).items():handler.send_header(key,value)
    handler.end_headers();handler.wfile.write(raw)
@pytest.mark.parametrize('sse',[False,True])
def test_real_http_json_and_sse_metadata_boundaries(server,sse,monkeypatch):
    monkeypatch.setenv('HTTP_PROXY','http://127.0.0.1:1')
    def send(h,request):
        envelope={'jsonrpc':'2.0','id':request['id'],'result':{'resultType':'complete','content':[{'type':'text','text':'safe'}]}}
        if sse:respond(h,b': keepalive\r\n\r\ndata: '+json.dumps({'jsonrpc':'2.0','method':'notifications/progress','params':{'progress':1}}).encode()+b'\n\ndata: '+json.dumps(envelope).encode()+b'\n\n','text/event-stream')
        else:respond(h,envelope)
    server.respond=send;result=M.rpc(connection(server),'tools/call',{'name':'fixture','arguments':{}},lambda:None)
    assert result['content'][0]['text']=='safe';path,headers,body=server.calls[0]
    assert path=='/mcp' and headers['MCP-Protocol-Version']==M.MCP_VERSION and headers['Mcp-Method']=='tools/call' and headers['Mcp-Name']=='fixture'
    assert body['params']['_meta']['io.modelcontextprotocol/clientCapabilities']=={}
    assert 'Cookie' not in headers and 'Origin' not in headers and len(server.calls)==1
@pytest.mark.parametrize('mode',['redirect','auth','gzip','oversize','wrong-id','missing-complete','input-required','notification-request','duplicate-json','wrong-type'])
def test_real_transport_rejects_unsupported_without_replay(server,mode):
    def send(h,request):
        value={'jsonrpc':'2.0','id':request['id'],'result':{'resultType':'complete','content':[]}}
        if mode=='redirect':return respond(h,b'',status=302,extra={'Location':'http://127.0.0.1:1/stolen'})
        if mode=='auth':return respond(h,b'',status=401)
        if mode=='gzip':return respond(h,b'compressed',extra={'Content-Encoding':'gzip'})
        if mode=='oversize':return respond(h,b'x'*(M.MAX_RESPONSE+1))
        if mode=='wrong-id':value['id']='other'
        if mode=='missing-complete':return respond(h,b'data: '+json.dumps({'jsonrpc':'2.0','method':'notifications/message','params':{}}).encode()+b'\n\n','text/event-stream')
        if mode=='input-required':value['result']['resultType']='input_required'
        if mode=='notification-request':return respond(h,b'data: '+json.dumps({'jsonrpc':'2.0','id':'remote','method':'sampling/createMessage','params':{}}).encode()+b'\n\n','text/event-stream')
        if mode=='duplicate-json':return respond(h,b'{"jsonrpc":"2.0","jsonrpc":"2.0"}')
        if mode=='wrong-type':return respond(h,b'<script>bad</script>','text/html')
        respond(h,value)
    server.respond=send
    with pytest.raises(HTTPException):M.rpc(connection(server),'server/discover',{},lambda:None)
    assert len(server.calls)==1
def test_total_deadline_dribble_and_no_implicit_reconnect(server,monkeypatch):
    monkeypatch.setattr(M,'TIMEOUT',.15)
    def send(h,request):
        h.send_response(200);h.send_header('Content-Type','text/event-stream');h.end_headers()
        try:
            for _ in range(50):h.wfile.write(b': waiting\n\n');h.wfile.flush();time.sleep(.03)
        except (BrokenPipeError,ConnectionResetError):pass
    server.respond=send;start=time.monotonic()
    with pytest.raises(HTTPException):M.rpc(connection(server),'server/discover',{},lambda:None)
    assert time.monotonic()-start<1 and len(server.calls)==1
def test_real_https_rejects_untrusted_certificate_before_bearer_and_checks_literal_ip(server,tmp_path,monkeypatch):
    import ipaddress
    import ssl
    from cryptography import x509
    from cryptography.x509.oid import NameOID
    from cryptography.hazmat.primitives import hashes,serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from datetime import datetime,timedelta,timezone
    key=rsa.generate_private_key(public_exponent=65537,key_size=2048);name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'Synthetic MCP')]);now=datetime.now(timezone.utc)
    cert=x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=1)).not_valid_after(now+timedelta(days=1)).add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]),critical=False).sign(key,hashes.SHA256())
    cp=tmp_path/'synthetic.pem';kp=tmp_path/'synthetic.key';cp.write_bytes(cert.public_bytes(serialization.Encoding.PEM));kp.write_bytes(key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
    context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(cp,kp);server.socket=context.wrap_socket(server.socket,server_side=True)
    server.respond=lambda h,r:respond(h,{'jsonrpc':'2.0','id':r['id'],'result':{'resultType':'complete','content':[]}})
    value={**connection(server),'scheme':'https'}
    with pytest.raises(HTTPException):M.rpc(value,'server/discover',{},lambda:None)
    assert not server.calls
    original=ssl.create_default_context;monkeypatch.setattr(M.ssl,'create_default_context',lambda:original(cafile=str(cp)))
    assert M.rpc(value,'server/discover',{},lambda:None)['resultType']=='complete'
    assert len(server.calls)==1 and server.calls[0][1]['Authorization']=='Bearer synthetic-remote-token'
def test_foreign_endpoint_review_is_not_consumed(api,remote):
    r=post(api,'connection-review',{'endpoint':'http://127.0.0.1:8124/mcp'}).json();api.cookies.set('tli_session',S.create_session_token('other'))
    assert post(api,'connect',{'review_token':r['review_token'],'token':'','reviewed':True}).status_code==409
    api.cookies.set('tli_session',api.browser);assert post(api,'connect',{'review_token':r['review_token'],'token':'','reviewed':True}).status_code==200
