"""Manual, ephemeral MCP client. No model registration, processes or disk writes.

Only explicitly reviewed literal-loopback endpoints are supported. Remote tool
metadata and returned values remain untrusted data; completion is not proof of
an effect. The supported schema subset is deliberately bounded and fail closed.
"""
from __future__ import annotations
import base64
import copy
import hashlib
import http.client
import ipaddress
import json
import math
import re
import secrets
import socket
import ssl
import threading
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit
from fastapi import HTTPException
import tli_state as S

PROTOCOL='tli-mcp-client-v1'
MCP_VERSION='2026-07-28'
TTL=900
TIMEOUT=12
MAX_RESPONSE=512*1024
MAX_RESULT=128*1024
MAX_ARGUMENTS=16384
MAX_TOOLS=64
LOCK=threading.RLock()
HTTP_SLOTS=threading.BoundedSemaphore(4)
CONNECTIONS={}
ENDPOINTS={}
REVIEWS={}
BUSY=set()
PENDING={}
_EXPIRY_TIMER=None
_EXPIRY_GENERATION=0
META={'io.modelcontextprotocol/protocolVersion':MCP_VERSION,'io.modelcontextprotocol/clientCapabilities':{},'io.modelcontextprotocol/clientInfo':{'name':'TLI reviewed manual client','version':'1'}}

def stamp():return datetime.now(timezone.utc).isoformat().replace('+00:00','Z')
def encoded(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode('utf-8')
def digest(value):return hashlib.sha256(encoded(value)).hexdigest()
def strict_json(raw):
    def pairs(rows):
        out={}
        for key,value in rows:
            if key in out:raise ValueError('Duplicate JSON field')
            out[key]=value
        return out
    def number(text):
        value=float(text)
        if not math.isfinite(value):raise ValueError('Nonfinite JSON')
        return value
    value=json.loads(raw,object_pairs_hook=pairs,parse_float=number,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('Nonfinite JSON')))
    encoded(value)  # Reject escaped, unpaired surrogate text before hashing/display.
    return value

def browser(request):
    if request.headers.get('authorization') is not None:raise HTTPException(403,'Use the owner PIN browser. Companion and delegated MCP credentials do not authorize this client.')
    if any(k.lower()=='forwarded' or k.lower().startswith('x-forwarded-') for k in request.headers):raise HTTPException(403,'This client requires a direct TLI connection; proxy headers are unsupported.')
    try:local=bool(request.client and ipaddress.ip_address(request.client.host).is_loopback)
    except ValueError:local=False
    if request.url.scheme!='https' and not local:raise HTTPException(403,'Open TLI through HTTPS or directly on its host before submitting a server credential.')
    if len(request.headers.getlist('origin'))>1 or request.headers.get('sec-fetch-site')=='cross-site' or request.headers.get('origin') not in (None,str(request.base_url).rstrip('/')):raise HTTPException(403,'Use this TLI page to review the MCP connection.')
    token=request.cookies.get('tli_session')
    if S.load_pin_config().get('enabled') is not True:raise HTTPException(409,'Set and unlock the owner PIN before using this optional MCP client.')
    if not token or not S.validate_session_token(token):raise HTTPException(401,'Unlock the owner PIN before using this MCP client.')
    return token,S.get_session_user_id(token)

def valid(value):return value['expires']>time.time() and S.load_pin_config().get('enabled') is True and S.validate_session_token(value['browser']) and S.get_session_user_id(value['browser'])==value['owner']
def purge():
    for records in (CONNECTIONS,ENDPOINTS,REVIEWS):
        for key,value in list(records.items()):
            if not valid(value):records.pop(key,None)
def schedule_cleanup():
    """One bounded timer removes expired in-memory records; never contacts a server."""
    global _EXPIRY_TIMER,_EXPIRY_GENERATION
    _EXPIRY_GENERATION+=1;generation=_EXPIRY_GENERATION
    if _EXPIRY_TIMER:_EXPIRY_TIMER.cancel();_EXPIRY_TIMER=None
    deadlines=[v['expires'] for records in (CONNECTIONS,ENDPOINTS,REVIEWS) for v in records.values()]
    if not deadlines:return
    def cleanup():
        with LOCK:
            if generation!=_EXPIRY_GENERATION:return
            purge();schedule_cleanup()
    _EXPIRY_TIMER=threading.Timer(max(.01,min(deadlines)-time.time()),cleanup);_EXPIRY_TIMER.daemon=True;_EXPIRY_TIMER.start()
def revoke_browser_session(token):
    with LOCK:
        PENDING.pop(token,None)
        for records in (CONNECTIONS,ENDPOINTS,REVIEWS):
            for key,value in list(records.items()):
                if value['browser']==token:records.pop(key,None)
        schedule_cleanup()
def revoke_all_connections():
    with LOCK:CONNECTIONS.clear();ENDPOINTS.clear();REVIEWS.clear();PENDING.clear();schedule_cleanup()
def lease(token):
    with LOCK:
        if token in BUSY:raise HTTPException(409,'Another MCP client operation is still running for this browser. No competing request started.')
        BUSY.add(token)
def release(token):
    with LOCK:BUSY.discard(token)
def live(value):
    with LOCK:
        if CONNECTIONS.get(value['id']) is not value or not valid(value):raise HTTPException(409,'This temporary MCP connection expired or changed. No automatic reconnect or retry runs.')
def current(request,ident):
    token,owner=browser(request)
    with LOCK:
        purge();value=CONNECTIONS.get(ident)
        if not value or value['browser']!=token or value['owner']!=owner:raise HTTPException(404,'No current MCP connection belongs to this PIN browser.')
        return value
def endpoint(raw,request):
    try:
        if not isinstance(raw,str) or len(raw)>512 or any(ord(c)<33 or ord(c)>126 for c in raw):raise ValueError()
        u=urlsplit(raw)
        if u.scheme not in ('http','https') or u.username or u.password or u.query or u.fragment or u.path not in ('/mcp','/api/mcp') or '%' in u.netloc:raise ValueError()
        address=ipaddress.ip_address(u.hostname)
        if not address.is_loopback or getattr(address,'ipv4_mapped',None) is not None or not u.port or not 1<=u.port<=65535:raise ValueError()
        actual_listener=request.scope.get('server')
        if u.port==(request.url.port or (443 if request.url.scheme=='https' else 80)) or actual_listener and u.port==actual_listener[1]:raise ValueError()
        host=str(address);authority=f'[{host}]' if address.version==6 else host
        return {'endpoint':f'{u.scheme}://{authority}:{u.port}{u.path}','scheme':u.scheme,'host':host,'port':u.port,'path':u.path}
    except (ValueError,TypeError,AttributeError):raise HTTPException(422,'Use an explicit literal-loopback HTTP(S) address, a different port from TLI, and exactly /mcp or /api/mcp. Hostnames, LAN/public addresses, credentials and URL parameters are unsupported.') from None

def header_value(value):
    text=str(value).lower() if isinstance(value,bool) else str(value)
    if text!=text.strip() or any(not (32<=ord(c)<=126 or c=='\t') for c in text) or text.startswith('=?base64?') and text.endswith('?='):
        return '=?base64?'+base64.b64encode(text.encode()).decode()+'?='
    return text

def rpc(connection,method,params,check,headers=None):
    """One owned POST, total deadline, no proxy/redirect/session/resume/replay."""
    if not HTTP_SLOTS.acquire(False):raise HTTPException(429,'Four MCP requests are still active. Retry later deliberately.')
    conn=None;timer=None;owned=[];timed_out=threading.Event()
    try:
        check();ident=secrets.token_hex(16);body={'jsonrpc':'2.0','id':ident,'method':method,'params':{**params,'_meta':META}}
        kwargs={'host':connection['host'],'port':connection['port'],'timeout':3}
        conn=http.client.HTTPSConnection(**kwargs,context=ssl.create_default_context()) if connection['scheme']=='https' else http.client.HTTPConnection(**kwargs)
        conn.auto_open=0
        def connect(address,timeout=3,source_address=None):
            sock=socket.create_connection((connection['host'],connection['port']),timeout,source_address)
            if ipaddress.ip_address(sock.getpeername()[0])!=ipaddress.ip_address(connection['host']):sock.close();raise OSError('Unexpected peer')
            owned.append(sock);return sock
        conn._create_connection=connect
        def stop():
            timed_out.set()
            for sock in owned:
                try:sock.shutdown(socket.SHUT_RDWR)
                except OSError:pass
            conn.close()
        timer=threading.Timer(TIMEOUT,stop);timer.daemon=True;timer.start()
        conn.connect()
        if conn.sock not in owned:owned.append(conn.sock)
        check()
        if timed_out.is_set():raise TimeoutError()
        outgoing={'Accept':'application/json, text/event-stream','Accept-Encoding':'identity','Content-Type':'application/json','MCP-Protocol-Version':MCP_VERSION,'Mcp-Method':method,**(headers or {})}
        if method=='tools/call':outgoing['Mcp-Name']=header_value(params['name'])
        if connection['token']:outgoing['Authorization']='Bearer '+connection['token']
        conn.request('POST',connection['path'],body=encoded(body),headers=outgoing)
        response=conn.getresponse()
        if 300<=response.status<400:raise HTTPException(502,'The MCP server redirected. Redirects and credential forwarding are disabled.')
        if response.status in (401,403):raise HTTPException(502,'The MCP server rejected its credential or origin. The TLI PIN session is separate.')
        if response.status!=200:raise HTTPException(502,'The MCP server rejected this protocol request. No version fallback or retry ran.')
        if response.getheader('Content-Encoding','identity').lower() not in ('','identity'):raise ValueError('Encoded response unsupported')
        length=response.getheader('Content-Length')
        if length is not None and (not length.isdigit() or int(length)>MAX_RESPONSE):raise ValueError('Response size limit')
        kind=response.getheader('Content-Type','').split(';')[0].strip().lower()
        if kind not in ('application/json','text/event-stream'):raise ValueError('Unsupported response type')
        data=bytearray();result=None
        if kind=='application/json':
            while True:
                chunk=response.read(min(65536,MAX_RESPONSE+1-len(data)))
                if not chunk:break
                data.extend(chunk)
                if len(data)>MAX_RESPONSE:raise ValueError('Response size limit')
            result=strict_json(data)
        else:
            # Ignore bounded request-related notifications; never dispatch their text.
            parts=[];events=0
            while True:
                line=response.readline(MAX_RESPONSE+1-len(data));data.extend(line)
                if len(data)>MAX_RESPONSE:raise ValueError('Response size limit')
                if not line:raise ValueError('Stream ended without a complete response')
                if line in (b'\n',b'\r\n'):
                    if not parts:continue
                    events+=1
                    if events>128:raise ValueError('Too many stream events')
                    item=strict_json(b'\n'.join(parts));parts=[]
                    if not isinstance(item,dict) or item.get('jsonrpc')!='2.0':raise ValueError('Invalid stream event')
                    if 'method' in item:
                        if 'id' in item or item['method'] not in ('notifications/progress','notifications/message'):raise ValueError('Unsupported server request or notification')
                        continue
                    result=item;break
                if line.startswith(b'data:'):parts.append(line[5:].lstrip(b' ').rstrip(b'\r\n'))
                elif line.startswith((b':',b'event:',b'id:',b'retry:')):continue
                else:raise ValueError('Unsupported SSE field')
        if timed_out.is_set():raise TimeoutError()
        check()
        if not isinstance(result,dict) or result.get('jsonrpc')!='2.0' or result.get('id')!=ident or ('result' in result)==('error' in result):raise ValueError('Unmatched JSON-RPC response')
        if 'error' in result:raise HTTPException(502,'The MCP server returned a protocol error. No automatic retry or additional interaction ran.')
        if not isinstance(result['result'],dict) or result['result'].get('resultType')!='complete':raise HTTPException(502,'The server did not return a complete result. Extra input, sampling, callbacks and continuation are unsupported; nothing was replayed.')
        return result['result']
    except HTTPException:raise
    except (ValueError,UnicodeError,RecursionError):raise HTTPException(502,'The MCP response was invalid, oversized or unsupported. It was not rendered or retried.') from None
    except (OSError,http.client.HTTPException):raise HTTPException(504 if timed_out.is_set() else 502,'The MCP request ended without a confirmed response. No reconnect or retry ran.') from None
    finally:
        if timer:timer.cancel()
        if conn:conn.close()
        HTTP_SLOTS.release()

SCHEMA_KEYS={'$schema','type','title','description','default','examples','properties','required','additionalProperties','items','enum','const','anyOf','oneOf','allOf','minimum','maximum','exclusiveMinimum','exclusiveMaximum','minLength','maxLength','minItems','maxItems','minProperties','maxProperties','x-mcp-header'}
TYPES={'object','array','string','integer','number','boolean','null'}
def schema_check(schema):
    count=[0];headers=[];used=set()
    def walk(s,path=(),static=True,depth=0):
        count[0]+=1
        if depth>12 or count[0]>256 or not isinstance(s,dict) or set(s)-SCHEMA_KEYS:raise ValueError('Unsupported schema keyword, reference or complexity')
        if s.get('$schema','https://json-schema.org/draft/2020-12/schema')!='https://json-schema.org/draft/2020-12/schema':raise ValueError('Only the 2020-12 schema dialect is supported')
        types=s.get('type');types=[types] if isinstance(types,str) else types
        if types is not None and (not isinstance(types,list) or not types or any(not isinstance(t,str) or t not in TYPES for t in types) or len(types)!=len(set(types))):raise ValueError('Invalid schema type')
        for key in ('title','description'):
            if key in s and not isinstance(s[key],str):raise ValueError('Invalid schema description')
        if 'enum' in s and (not isinstance(s['enum'],list) or not s['enum'] or len(s['enum'])>64):raise ValueError('Invalid enum')
        if 'examples' in s and not isinstance(s['examples'],list):raise ValueError('Invalid examples')
        for key in ('minimum','maximum','exclusiveMinimum','exclusiveMaximum'):
            if key in s and (type(s[key]) not in (int,float) or type(s[key]) is float and not math.isfinite(s[key])):raise ValueError('Invalid numerical bound')
        for key in ('minLength','maxLength','minItems','maxItems','minProperties','maxProperties'):
            if key in s and (type(s[key]) is not int or s[key]<0):raise ValueError('Invalid length bound')
        if 'required' in s and (not isinstance(s['required'],list) or any(not isinstance(k,str) for k in s['required']) or len(s['required'])!=len(set(s['required']))):raise ValueError('Invalid required fields')
        if 'x-mcp-header' in s:
            name=s['x-mcp-header']
            if not static or not path or types not in (['string'],['integer'],['boolean']) or not isinstance(name,str) or len(name)>64 or not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+",name) or name.lower() in used:raise ValueError('Invalid or nonstatic MCP parameter header')
            used.add(name.lower());headers.append((path,name))
        if 'properties' in s:
            if not isinstance(s['properties'],dict) or len(s['properties'])>64:raise ValueError('Invalid properties')
            for key,value in s['properties'].items():walk(value,path+(key,),static,depth+1)
        if 'additionalProperties' in s:
            if isinstance(s['additionalProperties'],dict):walk(s['additionalProperties'],(),False,depth+1)
            elif type(s['additionalProperties']) is not bool:raise ValueError('Invalid additionalProperties')
        if 'items' in s:walk(s['items'],(),False,depth+1)
        for key in ('anyOf','oneOf','allOf'):
            if key in s:
                if not isinstance(s[key],list) or not 1<=len(s[key])<=8:raise ValueError('Invalid schema alternatives')
                for item in s[key]:walk(item,(),False,depth+1)
    if len(encoded(schema))>16384:raise ValueError('Schema exceeds 16 KiB')
    walk(schema);return headers

def schema_matches(value,s,depth=0):
    if depth>12:return False
    def matches(v,rule):return schema_matches(v,rule,depth+1)
    actual='null' if value is None else 'boolean' if type(value) is bool else 'integer' if type(value) is int or type(value) is float and value.is_integer() else 'number' if type(value) is float else 'string' if isinstance(value,str) else 'array' if isinstance(value,list) else 'object' if isinstance(value,dict) else 'invalid'
    types=s.get('type');types=[types] if isinstance(types,str) else types
    if types is not None and actual not in types and not (actual=='integer' and 'number' in types):return False
    if 'enum' in s and not any(encoded(value)==encoded(item) or type(value) in (int,float) and type(item) in (int,float) and value==item for item in s['enum']):return False
    if 'const' in s and not (encoded(value)==encoded(s['const']) or type(value) in (int,float) and type(s['const']) in (int,float) and value==s['const']):return False
    for key in ('anyOf','oneOf','allOf'):
        if key in s:
            n=sum(matches(value,item) for item in s[key])
            if (key=='anyOf' and not n) or (key=='oneOf' and n!=1) or (key=='allOf' and n!=len(s[key])):return False
    if actual in ('integer','number'):
        for key,fn in [('minimum',lambda a,b:a>=b),('maximum',lambda a,b:a<=b),('exclusiveMinimum',lambda a,b:a>b),('exclusiveMaximum',lambda a,b:a<b)]:
            if key in s and not fn(value,s[key]):return False
    for label,kind in [('Length','string'),('Items','array'),('Properties','object')]:
        if actual==kind and not s.get('min'+label,0)<=len(value)<=s.get('max'+label,MAX_RESPONSE):return False
    if actual=='object':
        if any(k not in value for k in s.get('required',[])):return False
        for key,item in value.items():
            prop=s.get('properties',{}).get(key);extra=s.get('additionalProperties',True)
            if prop is not None:
                if not matches(item,prop):return False
            elif extra is False or isinstance(extra,dict) and not matches(item,extra):return False
    if actual=='array' and 'items' in s and any(not matches(item,s['items']) for item in value):return False
    return True

def argument_headers(args,paths):
    headers={}
    for path,name in paths:
        value=args
        for key in path:
            if not isinstance(value,dict) or key not in value:value=None;break
            value=value[key]
        if value is None:continue
        if type(value) in (int,float):
            if type(value) is float and (not math.isfinite(value) or not value.is_integer()) or abs(value)>2**53-1:raise HTTPException(422,'An integer mirrored in an MCP header exceeds the protocol safe-integer range.')
            value=int(value)
        headers['Mcp-Param-'+name]=header_value(value)
    if sum(len(k)+len(v) for k,v in headers.items())>16384:raise HTTPException(422,'Mirrored MCP parameter headers exceed 16 KiB.')
    return headers

def discover(connection,check):
    value=rpc(connection,'server/discover',{},check)
    if not isinstance(value.get('supportedVersions'),list) or MCP_VERSION not in value['supportedVersions'] or not isinstance(value.get('capabilities'),dict) or not isinstance(value['capabilities'].get('tools'),dict):raise HTTPException(409,'This server does not report the supported 2026-07-28 tool protocol. No fallback or tool invocation ran.')
    info=value.get('_meta',{}).get('io.modelcontextprotocol/serverInfo',{}) if isinstance(value.get('_meta',{}),dict) else None
    if not isinstance(info,dict) or len(encoded(info))>8192:raise HTTPException(502,'The server identity metadata is malformed or too large.')
    # Self-reported identity is bound to the review, never treated as authority.
    return {'server_info':info,'capabilities':value['capabilities'],'supported_versions':value['supportedVersions']}
def catalogue(connection,check):
    tools=[];seen=set();cursor=None;cursors=set()
    for page in range(8):
        value=rpc(connection,'tools/list',{'cursor':cursor} if cursor else {},check)
        rows=value.get('tools')
        if not isinstance(rows,list) or len(tools)+len(rows)>MAX_TOOLS:raise HTTPException(502,'The server tool catalogue exceeds the supported 64 tools or is malformed. No partial catalogue was adopted.')
        for tool in rows:
            if not isinstance(tool,dict) or not isinstance(tool.get('name'),str) or not 1<=len(tool['name'])<=128 or any(ord(c)<32 for c in tool['name']) or tool['name'] in seen or len(encoded(tool))>24576:raise HTTPException(502,'A tool has an invalid, duplicate or oversized identity/definition.')
            seen.add(tool['name']);supported=True;reason=None
            try:
                schema=tool['inputSchema']
                if not isinstance(schema,dict) or schema.get('type')!='object':raise ValueError('Tool inputs must have an object schema')
                schema_check(schema)
                if 'outputSchema' in tool:schema_check(tool['outputSchema'])
            except (KeyError,ValueError,TypeError,RecursionError) as exc:supported=False;reason=str(exc)[:200]
            tools.append({'definition':tool,'fingerprint':digest(tool),'supported':supported,'reason':reason})
        cursor=value.get('nextCursor')
        if cursor is None:return tools
        if not isinstance(cursor,str) or not cursor or len(cursor)>2048 or cursor in cursors or page==7:raise HTTPException(502,'Tool pagination is unsupported, repeated or exceeds eight pages. No partial catalogue was adopted.')
        cursors.add(cursor)
    raise HTTPException(502,'Tool pagination did not finish.')
def public_connection(value):return {'id':value['id'],'endpoint':value['endpoint'],'expires_at':datetime.fromtimestamp(value['expires'],timezone.utc).isoformat().replace('+00:00','Z'),'protocol_version':MCP_VERSION,'server_info':copy.deepcopy(value['identity']['server_info']),'catalogue_fingerprint':value['catalogue_hash'],'checked_at':value['checked_at'],'credential_supplied':bool(value['token'])}
def result(**fields):return {'ok':True,'protocol':PROTOCOL,**fields}
def status(request):
    token,owner=browser(request)
    with LOCK:
        purge();items=[public_connection(v) for v in CONNECTIONS.values() if v['browser']==token and v['owner']==owner]
        return result(connected=bool(items),connections=items,remote_requests=False)
def connection_review(request,data):
    token,owner=browser(request);target=endpoint(data['endpoint'],request)
    with LOCK:
        purge()
        if len(ENDPOINTS)>=32:raise HTTPException(429,'Too many connection reviews are active.')
        for key,v in list(ENDPOINTS.items()):
            if v['browser']==token:ENDPOINTS.pop(key,None)
        ident=secrets.token_hex(32);ENDPOINTS[ident]={'browser':token,'owner':owner,'expires':time.time()+300,**target}
        schedule_cleanup()
    return result(review_token=ident,endpoint=target['endpoint'],insecure_http=target['scheme']=='http',remote_requests=False,scope='Connect sends only protocol discovery and a tool-list request to this exact loopback endpoint. A tool invocation requires a separate review. Server identity, schemas and effect annotations are unverified claims.')
def connect(request,data):
    token,owner=browser(request)
    if data['reviewed'] is not True:raise HTTPException(422,'Review the exact endpoint before connecting.')
    credential=data['token']
    if not isinstance(credential,str) or len(credential)>4096 or any(ord(c)<33 or ord(c)>126 for c in credential):raise HTTPException(422,'Supply only an optional external Bearer token, at most 4096 visible ASCII characters.')
    lease(token)
    try:
        with LOCK:
            purge();review=ENDPOINTS.get(data['review_token'])
            if not review or review['browser']!=token or review['owner']!=owner:raise HTTPException(409,'This endpoint review expired or belongs to another browser.')
            ENDPOINTS.pop(data['review_token'])
            if len(CONNECTIONS)>=16 and not any(v['browser']==token for v in CONNECTIONS.values()):raise HTTPException(429,'Sixteen temporary MCP connections are already active.')
            ticket=secrets.token_hex(16);PENDING[token]=ticket
        candidate={**review,'token':credential,'expires':time.time()+TTL,'id':secrets.token_hex(16),'attempts':{}}
        def check():
            with LOCK:
                if PENDING.get(token)!=ticket or not valid(candidate):raise HTTPException(409,'The connecting PIN session expired or was disconnected. No candidate was adopted.')
        identity=discover(candidate,check);tools=catalogue(candidate,check);check()
        candidate.update(identity=identity,tools=tools,catalogue_hash=digest(tools),checked_at=stamp())
        with LOCK:
            check();revoke_browser_session(token);CONNECTIONS[candidate['id']]=candidate;schedule_cleanup()
            return result(connection=public_connection(candidate),tools=copy.deepcopy(tools),tool_invoked=False)
    finally:
        with LOCK:PENDING.pop(token,None)
        release(token)
def disconnect(request,data):
    token,owner=browser(request)
    with LOCK:
        PENDING.pop(token,None)
        if data['connection_id']:
            value=CONNECTIONS.get(data['connection_id'])
            if value and (value['browser']!=token or value['owner']!=owner):raise HTTPException(404,'No matching connection belongs to this browser.')
            if value:revoke_browser_session(token)
        else:revoke_browser_session(token)
    return result(disconnected=True,remote_requests=False,submitted_work_cancelled=False)
def list_tools(request,data):
    value=current(request,data['connection_id']);lease(value['browser'])
    try:
        identity=discover(value,lambda:live(value));tools=catalogue(value,lambda:live(value));live(value)
        with LOCK:
            live(value)
            if identity!=value['identity'] or digest(tools)!=value['catalogue_hash']:
                for key,r in list(REVIEWS.items()):
                    if r['connection_id']==value['id']:REVIEWS.pop(key,None)
            value.update(identity=identity,tools=tools,catalogue_hash=digest(tools),checked_at=stamp())
            return result(connection=public_connection(value),tools=copy.deepcopy(tools),tool_invoked=False)
    finally:release(value['browser'])
def tool_review(request,data):
    value=current(request,data['connection_id']);args=data['arguments']
    if not isinstance(args,dict) or len(encoded(args))>MAX_ARGUMENTS:raise HTTPException(422,'Tool arguments must be one JSON object, at most 16 KiB.')
    lease(value['browser'])
    try:
        identity=discover(value,lambda:live(value));tools=catalogue(value,lambda:live(value));live(value)
        if identity!=value['identity'] or digest(tools)!=value['catalogue_hash']:raise HTTPException(409,'The server identity or tool catalogue changed. Refresh the list and review the new exact definition before invoking.')
        tool=next((t for t in tools if t['definition']['name']==data['tool_name']),None)
        if not tool or tool['fingerprint']!=data['tool_fingerprint']:raise HTTPException(409,'The selected tool definition changed or was not listed.')
        if not tool['supported']:raise HTTPException(422,'This tool schema is unsupported: '+tool['reason'])
        if not schema_matches(args,tool['definition']['inputSchema']):raise HTTPException(422,'The JSON arguments do not match the exact supported input schema. Nothing was invoked.')
        headers=argument_headers(args,schema_check(tool['definition']['inputSchema']))
        exact={'endpoint':value['endpoint'],'server_info':identity['server_info'],'tool':tool['definition'],'tool_fingerprint':tool['fingerprint'],'arguments':copy.deepcopy(args),'mirrored_headers':headers,'actual_effect':'unknown','annotations_are_server_claims':True}
        with LOCK:
            purge();live(value)
            if len(REVIEWS)>=64:raise HTTPException(429,'Too many invocation reviews are active.')
            for key,r in list(REVIEWS.items()):
                if r['connection_id']==value['id']:REVIEWS.pop(key,None)
            ident=secrets.token_hex(32);review={'browser':value['browser'],'owner':value['owner'],'expires':min(time.time()+120,value['expires']),'connection_id':value['id'],'review_hash':digest(exact),'exact':exact,'catalogue_hash':value['catalogue_hash'],'identity':identity}
            REVIEWS[ident]=review
            schedule_cleanup()
        return result(review_token=ident,review_hash=review['review_hash'],expires_at=datetime.fromtimestamp(review['expires'],timezone.utc).isoformat().replace('+00:00','Z'),review=exact,tool_invoked=False)
    finally:release(value['browser'])
def project_output(value,tool):
    content=value.get('content')
    if not isinstance(content,list) or len(content)>128 or type(value.get('isError',False)) is not bool:raise ValueError('Malformed tool output')
    text=[];omitted=0
    for item in content:
        if not isinstance(item,dict):raise ValueError('Malformed content')
        if item.get('type')=='text':
            if not isinstance(item.get('text'),str):raise ValueError('Malformed text')
            text.append(item['text'])
        else:omitted+=1
    output={'text':text,'omitted_content_items':omitted,'is_error':value.get('isError',False)}
    if 'structuredContent' in value:output['structured']=value['structuredContent']
    if 'outputSchema' in tool and (('structuredContent' not in value or not schema_matches(value['structuredContent'],tool['outputSchema'])) and not output['is_error']):raise ValueError('Output does not match schema')
    if len(encoded(output))>MAX_RESULT:raise ValueError('Projected output exceeds 128 KiB')
    return output
def invoke(request,data):
    value=current(request,data['connection_id']);rid=data['request_id']
    if data['reviewed'] is not True or not re.fullmatch(r'[a-zA-Z0-9_-]{16,96}',rid):raise HTTPException(422,'Explicitly confirm the reviewed invocation and supply one bounded request ID.')
    binding=digest({k:data[k] for k in ('connection_id','review_token','review_hash')})
    with LOCK:
        old=value['attempts'].get(rid)
        if old:
            if old['binding']!=binding:raise HTTPException(409,'This request ID was already used for a different invocation.')
            if 'receipt' not in old:raise HTTPException(409,'This invocation is still pending. It was not sent again.')
            live(value);return copy.deepcopy(old['receipt'])
    lease(value['browser']);started=False
    try:
        with LOCK:
            purge();live(value)
            if len(value['attempts'])>=32:raise HTTPException(429,'This temporary connection has reached 32 invocation attempts. Disconnect and review a new connection to continue.')
            review=REVIEWS.get(data['review_token'])
            if not review or review['browser']!=value['browser'] or review['owner']!=value['owner'] or review['connection_id']!=value['id'] or review['review_hash']!=data['review_hash']:raise HTTPException(409,'This invocation review expired, changed or was already consumed.')
            REVIEWS.pop(data['review_token']);value['attempts'][rid]={'binding':binding}
        try:
            identity=discover(value,lambda:live(value));tools=catalogue(value,lambda:live(value));live(value)
            if identity!=review['identity'] or digest(tools)!=review['catalogue_hash']:raise HTTPException(409,'The server or catalogue changed after review. Nothing was invoked; review again deliberately.')
            exact=review['exact'];started=True
            raw=rpc(value,'tools/call',{'name':exact['tool']['name'],'arguments':exact['arguments']},lambda:live(value),exact['mirrored_headers'])
            output=project_output(raw,exact['tool']);live(value)
            receipt=result(request_id=rid,outcome='server_error' if output['is_error'] else 'completed',checked_at=stamp(),tool_invoked=True,actual_effect='unknown',endpoint=value['endpoint'],tool_name=exact['tool']['name'],review_hash=review['review_hash'],output=output,requires_review=True,message='The server returned this result. TLI has not verified its claims or physical effects. No follow-up instruction, resource fetch or automatic retry ran.')
        except (HTTPException,ValueError,RecursionError) as exc:
            live(value)
            receipt=result(request_id=rid,outcome='unknown' if started else 'not_sent',checked_at=stamp(),tool_invoked=None if started else False,actual_effect='unknown' if started else 'not_invoked',requires_review=True,message=('The invocation outcome is uncertain. A remote effect may have occurred. ' if started else 'No tool invocation was sent. ')+(exc.detail if isinstance(exc,HTTPException) else 'The returned output was invalid, oversized or did not match its schema.')+' No automatic retry runs.')
        with LOCK:
            live(value);value['attempts'][rid]['receipt']=copy.deepcopy(receipt)
        return receipt
    finally:release(value['browser'])
