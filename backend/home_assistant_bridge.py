"""Explicit, session-only Home Assistant REST bridge. No registry or key writes."""
from __future__ import annotations
import copy
import hashlib
import http.client
import ipaddress
import json
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
import device_commands

PROTOCOL='tli-home-assistant-v1'
TTL=900
MAX_RESPONSE=2*1024*1024
MAX_ENTITIES=2000
REQUEST_TIMEOUT=8
LOCK=threading.RLock()
CONNECTIONS={}
REVIEWS={}
ORIGINS={}
BUSY=set()
PENDING={}
DNS_SLOTS=threading.BoundedSemaphore(2)
HTTP_SLOTS=threading.BoundedSemaphore(4)
ENTITY=re.compile(r'^(light|switch)\.[a-z0-9_]{1,120}$')
NETWORKS=[ipaddress.ip_network(n) for n in ('10.0.0.0/8','172.16.0.0/12','192.168.0.0/16','127.0.0.0/8','fc00::/7','::1/128')]

def stamp():return datetime.now(timezone.utc).isoformat().replace('+00:00','Z')
def digest(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()).hexdigest()
def browser(request):
    if request.headers.get('authorization') is not None: raise HTTPException(403,'Manage Home Assistant from the PIN browser; Companion and MCP credentials are not accepted.')
    if any(k.lower()=='forwarded' or k.lower().startswith('x-forwarded-') for k in request.headers): raise HTTPException(403,'This bridge requires a direct TLI connection; proxy headers are unsupported.')
    try: local=bool(request.client and ipaddress.ip_address(request.client.host).is_loopback)
    except ValueError:local=False
    if request.url.scheme!='https' and not local: raise HTTPException(403,'Use TLI through HTTPS or on its host before submitting Home Assistant credentials.')
    if len(request.headers.getlist('origin'))>1 or request.headers.get('sec-fetch-site')=='cross-site' or request.headers.get('origin') not in (None,str(request.base_url).rstrip('/')):
        raise HTTPException(403,'Use this TLI page to review Home Assistant access.')
    token=request.cookies.get('tli_session')
    if S.load_pin_config().get('enabled') is not True: raise HTTPException(409,'Set and unlock the owner PIN before connecting Home Assistant.')
    if not token or not S.validate_session_token(token): raise HTTPException(401,'Unlock the owner PIN before managing Home Assistant.')
    return token,S.get_session_user_id(token)

def _valid(value):
    return value['expires']>time.time() and S.load_pin_config().get('enabled') is True and S.validate_session_token(value['browser']) and S.get_session_user_id(value['browser'])==value['owner']
def purge():
    for records in (CONNECTIONS,ORIGINS,REVIEWS):
        for ident,value in list(records.items()):
            if not _valid(value):records.pop(ident,None)
def revoke_browser_session(token):
    with LOCK:
        PENDING.pop(token,None)
        for records in (CONNECTIONS,ORIGINS,REVIEWS):
            for ident,value in list(records.items()):
                if value['browser']==token:records.pop(ident,None)
def revoke_all_connections():
    with LOCK:CONNECTIONS.clear();ORIGINS.clear();REVIEWS.clear();PENDING.clear()
def _lease(key):
    with LOCK:
        if key in BUSY:raise HTTPException(409,'A Home Assistant operation for this browser is still running. No competing request started.')
        BUSY.add(key)
def _release(key):
    with LOCK:BUSY.discard(key)
def _live(value):
    with LOCK:
        if CONNECTIONS.get(value['id']) is not value or not _valid(value):raise HTTPException(409,'This temporary Home Assistant connection expired or changed. No automatic reconnect runs.')

def _address(value):
    address=ipaddress.ip_address(value)
    if getattr(address,'ipv4_mapped',None):address=address.ipv4_mapped
    if not any(address.version==network.version and address in network for network in NETWORKS):raise ValueError('Only reviewed private or loopback addresses are supported')
    return str(address)
def resolve(host):
    try:return (_address(host),)
    except ValueError:
        try:ipaddress.ip_address(host)
        except ValueError:pass
        else:raise HTTPException(422,'Use a private LAN, ULA or loopback Home Assistant address; public, link-local and metadata addresses are unsupported.') from None
    if not DNS_SLOTS.acquire(False):raise HTTPException(429,'Two hostname resolutions are still active. Retry later deliberately.')
    done=threading.Event();out=[]
    def lookup():
        try:
            rows=socket.getaddrinfo(host,None,type=socket.SOCK_STREAM)
            if not rows or len(rows)>32:raise ValueError('Bounded DNS resolution failed')
            out.append(tuple(sorted({_address(row[4][0]) for row in rows})))
        except Exception:out.append(None)
        finally:DNS_SLOTS.release();done.set()
    threading.Thread(target=lookup,daemon=True).start()
    if not done.wait(3):raise HTTPException(504,'Home Assistant hostname resolution timed out. Nothing was contacted or retried.')
    if not out[0]:raise HTTPException(422,'Every resolved Home Assistant address must be a private LAN, ULA or loopback address.')
    return out[0]
def origin(value,allow_http,request):
    try:
        if not isinstance(value,str) or len(value)>512 or any(ord(c)<33 for c in value):raise ValueError()
        parsed=urlsplit(value)
        if parsed.scheme not in ('http','https') or parsed.username or parsed.password or parsed.path not in ('','/') or parsed.query or parsed.fragment:raise ValueError()
        host=parsed.hostname.encode('idna').decode('ascii').lower()
        if '%' in host or len(host)>253:raise ValueError()
        if ':' not in host and not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?',host):raise ValueError()
        port=parsed.port or (443 if parsed.scheme=='https' else 80)
        if not 1<=port<=65535:raise ValueError()
    except (ValueError,TypeError,AttributeError,UnicodeError):raise HTTPException(422,'Use only an http(s) Home Assistant origin, with its explicit port when required. No path, credentials, query or fragment.') from None
    if type(allow_http) is not bool or parsed.scheme=='http' and allow_http is not True:raise HTTPException(422,'Review that HTTP sends this token and states unencrypted to the selected Home Assistant origin, or use verified HTTPS.')
    addresses=resolve(host)
    # Do not turn the bridge into a recursive call to the current TLI listener.
    if any(ipaddress.ip_address(ip).is_loopback for ip in addresses) and port==(request.url.port or (443 if request.url.scheme=='https' else 80)):
        raise HTTPException(422,'Choose the Home Assistant listener, not this TLI listener on the same loopback port.')
    authority=f'[{host}]' if ':' in host else host
    return {'origin':f'{parsed.scheme}://{authority}:{port}','scheme':parsed.scheme,'host':host,'port':port,'addresses':addresses,'allow_http':allow_http}

def _json(raw):
    def pairs(rows):
        out={}
        for key,value in rows:
            if key in out:raise ValueError('Duplicate response field')
            out[key]=value
        return out
    def number(text):
        value=float(text)
        if not __import__('math').isfinite(value):raise ValueError('Nonfinite response')
        return value
    return json.loads(raw,object_pairs_hook=pairs,parse_float=number,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('Invalid response number')))

def request_json(connection,method,path,body=None,check=None):
    """DNS is rechecked, TCP is pinned, TLS keeps original hostname verification."""
    if resolve(connection['host'])!=tuple(connection['addresses']):raise HTTPException(409,'Home Assistant resolved addresses changed after review. Reconnect deliberately before sending its token.')
    if not HTTP_SLOTS.acquire(False):raise HTTPException(429,'Four Home Assistant requests are active. Retry later deliberately.')
    conn=None;timer=None;owned=[];timed_out=threading.Event()
    try:
        if check:check()
        kwargs={'host':connection['host'],'port':connection['port'],'timeout':3}
        conn=http.client.HTTPSConnection(**kwargs,context=ssl.create_default_context()) if connection['scheme']=='https' else http.client.HTTPConnection(**kwargs)
        conn.auto_open=0  # A deadline/closed socket must never reconnect implicitly.
        pinned=connection['addresses'][0]
        def connect(_address,timeout=3,source_address=None):
            sock=socket.create_connection((pinned,connection['port']),timeout,source_address)
            if _address_ip(sock.getpeername()[0])!=pinned:sock.close();raise OSError('Unexpected connected peer')
            owned.append(sock);return sock
        conn._create_connection=connect
        def stop():
            timed_out.set()
            for sock in owned:
                try:sock.shutdown(socket.SHUT_RDWR)
                except OSError:pass
            if conn:conn.close()
        timer=threading.Timer(REQUEST_TIMEOUT,stop);timer.daemon=True;timer.start()
        conn.connect()
        if timed_out.is_set():raise TimeoutError()
        # HTTPSConnection replaces the connected socket with its TLS wrapper.
        if conn.sock not in owned:owned.append(conn.sock)
        if check:check()
        if timed_out.is_set():raise TimeoutError()
        payload=json.dumps(body,separators=(',',':')).encode() if body is not None else None
        conn.request(method,path,body=payload,headers={'Authorization':'Bearer '+connection['token'],'Accept':'application/json','Accept-Encoding':'identity','Content-Type':'application/json'})
        reply=conn.getresponse()
        if 300<=reply.status<400:raise HTTPException(502,'Home Assistant redirected this request. Redirects and credential forwarding are disabled.')
        if reply.status in (401,403):raise HTTPException(502,'Home Assistant rejected this access token or permission. The TLI PIN session is separate.')
        if reply.status==404:raise HTTPException(409,'The exact Home Assistant entity or API was not found. Review the current connection and entity ID.')
        if not 200<=reply.status<300:raise HTTPException(502,'Home Assistant did not acknowledge this request. No automatic retry runs.')
        if reply.getheader('Content-Encoding','identity').lower() not in ('','identity'):raise ValueError('Unsupported encoded response')
        if reply.getheader('Content-Type','').split(';')[0].strip().lower()!='application/json':raise ValueError('Unexpected response content type')
        length=reply.getheader('Content-Length')
        if length is not None and (not length.isdigit() or int(length)>MAX_RESPONSE):raise ValueError('Response size limit')
        data=bytearray()
        while True:
            chunk=reply.read(min(65536,MAX_RESPONSE+1-len(data)))
            if not chunk:break
            data.extend(chunk)
            if len(data)>MAX_RESPONSE:raise ValueError('Response size limit')
        value=_json(data)
        if timed_out.is_set():raise TimeoutError()
        if check:check()
        return value
    except HTTPException:raise
    except (OSError,ValueError,http.client.HTTPException,RecursionError):raise HTTPException(502,'Home Assistant returned an unreadable response or did not finish within its bounded request window. No retry ran; an attempted action may be unconfirmed.') from None
    finally:
        if timer:timer.cancel()
        if conn:conn.close()
        HTTP_SLOTS.release()
def _address_ip(value):return str(ipaddress.ip_address(value))

def summary(value):
    return {'id':value['id'],'origin':value['origin'],'addresses':list(value['addresses']),'expires_at':datetime.fromtimestamp(value['expires'],timezone.utc).isoformat().replace('+00:00','Z'),'insecure_http':value['scheme']=='http','scope':'Explicit light/switch state reads and individually reviewed turn_on/turn_off only. No scenes, AI registration, background refresh or persistent credentials.'}
def status(request):
    token,_=browser(request)
    with LOCK:
        purge();values=[summary(v) for v in CONNECTIONS.values() if v['browser']==token]
    return {'ok':True,'protocol':PROTOCOL,'connected':bool(values),'connections':values,'actions_performed':False,'checked_at':stamp()}
def connection_review(request,data):
    token,owner=browser(request);target=origin(data.get('origin'),data.get('allow_insecure_http'),request)
    if browser(request)!=(token,owner):raise HTTPException(401,'The PIN account changed during origin review. Start again from the current account.')
    with LOCK:
        purge()
        if len(ORIGINS)>=32:raise HTTPException(429,'Too many temporary connection reviews. Wait for their expiry.')
        key=secrets.token_hex(32);value={**target,'browser':token,'owner':owner,'expires':time.time()+300}
        ORIGINS[key]=value
    return {'ok':True,'protocol':PROTOCOL,'review_token':key,'origin':target['origin'],'addresses':list(target['addresses']),'insecure_http':target['scheme']=='http','expires_in_seconds':300,'actions_performed':False,'credential_sent':False,
            'scope':'Only the reviewed Home Assistant origin receives the token. Its fixed /api/ authentication check runs on Connect. States require a separate explicit read.'}
def connect(request,data):
    token,owner=browser(request);key=data.get('review_token');secret=data.get('token')
    if not isinstance(secret,str) or not 16<=len(secret)<=4096 or any(ord(c)<33 or ord(c)>126 for c in secret):raise HTTPException(422,'Enter the complete Home Assistant access token without whitespace.')
    _lease(token);ticket=object()
    try:
        with LOCK:
            PENDING[token]=ticket
            purge();review=ORIGINS.get(key)
            if not review or review['browser']!=token:raise HTTPException(409,'Review this exact Home Assistant origin again before connecting.')
            if len(CONNECTIONS)>=16 and not any(v['browser']==token for v in CONNECTIONS.values()):raise HTTPException(429,'Too many temporary connections.')
        value={**review,'id':secrets.token_hex(16),'token':secret,'expires':time.time()+TTL}
        def candidate_valid():
            if browser(request)!=(token,owner):raise HTTPException(401,'The PIN account changed while connecting. The candidate was discarded.')
            with LOCK:
                if PENDING.get(token) is not ticket:raise HTTPException(409,'The pending connection was disconnected. Its late result was discarded.')
        result=request_json(value,'GET','/api/',check=candidate_valid)
        if not isinstance(result,dict) or result.get('message')!='API running.':raise HTTPException(502,'The reviewed origin did not confirm the supported Home Assistant REST API. The previous connection was retained.')
        with LOCK:
            candidate_valid()
            if PENDING.get(token) is not ticket:raise HTTPException(409,'This connection was disconnected or invalidated while connecting. The late response was discarded.')
            revoke_browser_session(token);CONNECTIONS[value['id']]=value
        return {'ok':True,'protocol':PROTOCOL,'connection':summary(value),'actions_performed':False,'states_read':False}
    finally:
        with LOCK:
            if PENDING.get(token) is ticket:PENDING.pop(token,None)
        _release(token)
def connection(request,ident):
    token,_=browser(request)
    with LOCK:
        purge();value=CONNECTIONS.get(ident)
        if not value or value['browser']!=token:raise HTTPException(409,'This Home Assistant connection expired or is not owned by this PIN browser. Reconnect deliberately.')
        return value
def disconnect(request,data):
    token,_=browser(request)
    with LOCK:
        PENDING.pop(token,None)
        value=CONNECTIONS.get(data.get('connection_id'))
        if value and value['browser']!=token:raise HTTPException(404,'Connection not found for this browser.')
        if value:
            CONNECTIONS.pop(value['id'],None)
            for key,review in list(REVIEWS.items()):
                if review['connection_id']==value['id']:REVIEWS.pop(key,None)
    return {'ok':True,'protocol':PROTOCOL,'disconnected':True,'actions_performed':False,'scope':'The temporary TLI connection ended. This does not revoke the token inside Home Assistant or cancel an already submitted action.'}

def entity(raw,expected=None):
    if not isinstance(raw,dict) or not isinstance(raw.get('entity_id'),str) or not ENTITY.fullmatch(raw['entity_id']) or expected is not None and raw['entity_id']!=expected:raise HTTPException(502,'Home Assistant did not return the exact supported entity identity.')
    state=raw.get('state');attrs=raw.get('attributes')
    if not isinstance(state,str) or len(state)>256 or not isinstance(attrs,dict):raise HTTPException(502,'Home Assistant returned an invalid entity state.')
    def text(value,limit):return value if isinstance(value,str) and len(value)<=limit else None
    return {'entity_id':raw['entity_id'],'name':text(attrs.get('friendly_name'),160) or raw['entity_id'],'state':state,'availability':'unavailable' if state=='unavailable' else 'unknown' if state=='unknown' else 'reported',
            'unit':text(attrs.get('unit_of_measurement'),64),'last_changed':text(raw.get('last_changed'),64),'last_updated':text(raw.get('last_updated'),64),'revision':digest(raw),
            'can_review_action':state in ('on','off')}
def states(request,data):
    value=connection(request,data.get('connection_id'));_lease(value['browser'])
    try:
        raw=request_json(value,'GET','/api/states',check=lambda:_live(value))
        if not isinstance(raw,list) or len(raw)>MAX_ENTITIES:raise HTTPException(502,'Home Assistant states exceeded the supported 2,000-entity scope or returned an invalid list.')
        rows=[];seen=set();omitted=0
        for item in raw:
            if not isinstance(item,dict) or not isinstance(item.get('entity_id'),str):raise HTTPException(502,'Home Assistant returned a malformed state list; previous results were retained.')
            if item['entity_id'] in seen:raise HTTPException(502,'Home Assistant returned duplicate entity identities; previous results were retained.')
            seen.add(item['entity_id'])
            if ENTITY.fullmatch(item['entity_id']):rows.append(entity(item))
            else:omitted+=1
        _live(value)
        return {'ok':True,'protocol':PROTOCOL,'connection_id':value['id'],'origin':value['origin'],'checked_at':stamp(),'items':rows,'omitted_entities':omitted,'actions_performed':False,
                'scope':'Home Assistant state-list response projected to lights and switches. Other domains, arbitrary attributes, history and private URLs are excluded and not saved. Reported state does not prove physical device state.'}
    finally:_release(value['browser'])
def action_review(request,data):
    value=connection(request,data.get('connection_id'));ident=data.get('entity_id');action=data.get('action')
    if not isinstance(ident,str) or not ENTITY.fullmatch(ident) or action not in ('turn_on','turn_off'):raise HTTPException(422,'Review one exact light or switch entity and turn_on or turn_off; no other service or target is supported.')
    _lease(value['browser'])
    try:
        current=entity(request_json(value,'GET','/api/states/'+ident,check=lambda:_live(value)),ident)
        if not current['can_review_action']:raise HTTPException(409,'Home Assistant reports this entity as unknown or unavailable. No action can be reviewed until an explicit state read is available.')
        target={'connection_id':value['id'],'origin':value['origin'],'addresses':list(value['addresses']),'entity':current,'action':action,'domain':ident.split('.')[0]}
        with LOCK:
            purge()
            if len(REVIEWS)>=64:raise HTTPException(429,'Too many active action reviews; wait for their expiry.')
            key=secrets.token_hex(32);review_hash=digest(target)
            REVIEWS[key]={'browser':value['browser'],'owner':value['owner'],'expires':min(value['expires'],time.time()+120),'connection_id':value['id'],'target':target,'hash':review_hash,'request_id':None}
        _live(value)
        return {'ok':True,'protocol':PROTOCOL,'review_token':key,'review_hash':review_hash,'target':target,'checked_at':stamp(),'expires_in_seconds':120,'actions_performed':False,
                'scope':'Run submits one Home Assistant service action for this exact entity. The entity ID must still represent the device you intend. Review its origin and name; service acknowledgment is not physical confirmation.'}
    finally:_release(value['browser'])
def execute(request,data):
    value=connection(request,data.get('connection_id'));request_id=data.get('request_id')
    if not isinstance(request_id,str) or not re.fullmatch('[a-f0-9-]{32,36}',request_id) or data.get('reviewed') is not True:raise HTTPException(422,'Explicitly confirm this reviewed action with its request identifier.')
    with LOCK:
        review=REVIEWS.get(data.get('review_token'))
        if not review or not _valid(review) or review['browser']!=value['browser'] or review['connection_id']!=value['id'] or review['hash']!=data.get('review_hash'):raise HTTPException(409,'This action review expired or changed. Review the exact entity again before running.')
        if review['request_id'] not in (None,request_id):raise HTTPException(409,'This review already belongs to another submission. No action was repeated.')
        review['request_id']=request_id
        if 'receipt' in review:return copy.deepcopy(review['receipt'])
        if review.get('running'):raise HTTPException(409,'This reviewed action is still running. No second action was submitted.')
        _lease(value['browser'])
        review['running']=True
    try:return _execute_review(value,review,request_id)
    finally:
        with LOCK:review['running']=False
        _release(value['browser'])

def _execute_review(value,review,request_id):
    target=review['target'];ident=target['entity']['entity_id'];attempted=[False]
    def operation():
        # Runs under device_commands' exact-target lock, including the fresh
        # preflight; a competing action cannot use an earlier state snapshot.
        fresh=entity(request_json(value,'GET','/api/states/'+ident,check=lambda:_live(value)),ident)
        if fresh['revision']!=target['entity']['revision']:
            return {'ok':False,'actions_performed':False,'requires_review':True,'summary':'The exact entity changed since review. No service action was submitted. Read its state and review again.'}
        _live(value)
        attempted[0]=True
        raw=request_json(value,'POST','/api/services/'+target['domain']+'/'+target['action'],{'entity_id':ident},check=lambda:_live(value))
        if not isinstance(raw,list) or len(raw)>MAX_ENTITIES:raise ValueError('Unconfirmed service acknowledgment')
        # The returned changed-state list can include unrelated changes, so it
        # is never treated as proof that this physical device reached the goal.
        return {'ok':True,'actions_performed':True,'physical_confirmation':False,'entity_id':ident,'action':target['action'],'origin':value['origin']}
    result=device_commands.run(value['owner'],('home_assistant',value['origin'],ident),(value['id'],target['action'],review['hash']),request_id,operation)
    _live(value)
    result=dict(result)
    if result.get('ok') is True:result['summary']='Home Assistant acknowledged the service action. Physical state is unverified. Use an explicit state read before another action.'
    elif result.get('outcome')=='unknown':
        if attempted[0]:result.update(actions_performed=None,summary='The action outcome is unconfirmed. No automatic retry runs. Read Home Assistant state before deciding whether to review another action.')
        else:result.update(actions_performed=False,outcome='failed',summary='The fresh entity check could not be completed. No service action was submitted. Read the exact entity and review again.')
    receipt={'protocol':PROTOCOL,**result,'connection_id':value['id'],'checked_at':stamp(),'inference_called':False}
    with LOCK:
        # Repeated request IDs retain the original receipt time and uncertainty;
        # they never become an apparently new observation or attempt.
        if 'receipt' not in review:review['receipt']=copy.deepcopy(receipt)
        return copy.deepcopy(review['receipt'])
