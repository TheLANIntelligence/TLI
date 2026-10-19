"""Explicit, ephemeral, loopback-only MCP grants and read-only projections.

No SDK, inference, scanner, driver or credential store is initialized here.
MCP authorization is deliberately separate from browser/Companion credentials.
"""
from __future__ import annotations
import hashlib
import ipaddress
import json
import math
from pathlib import Path
import secrets
import threading
import time
from datetime import datetime, timezone
from fastapi import HTTPException, Request
import tli_state as S

PROTOCOL = '2026-07-28'
UI_PROTOCOL = 'tli-mcp-bridge-v1'
ENDPOINT = '/api/mcp'
TTL = 900
MAX_BODY = 16 * 1024
MAX_REPLY = 128 * 1024
LOCK = threading.RLock()
GRANTS = {}
_READ_SLOTS = threading.BoundedSemaphore(2)
SCOPES = ('registry', 'health', 'rooms')
TOOL_SCOPES = {'tli_registered_devices':'registry','tli_reported_health':'health','tli_recorded_rooms':'rooms'}
_TITLES = {'registry':'Registered computers & devices','health':'Recorded host metrics','rooms':'Recorded room assignments'}
_DESCRIPTIONS = {
 'registry':'Read a bounded page of this host’s registered computers/devices. Names, identifiers, addresses and recorded room assignments are shared. Registration is not proof of reachability. No scanning or device actions.',
 'health':'Read existing host CPU/RAM/disk observations with their observation time and 30-second freshness. No new health probe, model check, inference or diagnostic runs.',
 'rooms':'Read recorded room labels and device assignments. Rooms are user/registry metadata, not detected occupancy or location. No devices are contacted.',
}

def iso(value): return datetime.fromtimestamp(value, timezone.utc).isoformat().replace('+00:00','Z')

def loopback(request: Request):
    """Both socket peer and authority must be local; proxy headers are unsupported."""
    from browser_authority import direct_request_address
    try:
        if any(k.lower() == 'forwarded' or k.lower().startswith('x-forwarded-') for k in request.headers): raise ValueError()
        if not request.client or not ipaddress.ip_address(request.client.host).is_loopback: raise ValueError()
        parsed = direct_request_address(request); host = parsed.hostname
        if host != 'localhost' and not ipaddress.ip_address(host).is_loopback: raise ValueError()
        if parsed.username or parsed.password or parsed.scheme not in ('http','https') or parsed.port is not None and not 1 <= parsed.port <= 65535: raise ValueError()
        origin = request.headers.get('origin')
        if len(request.headers.getlist('origin')) > 1 or request.headers.get('sec-fetch-site') == 'cross-site' or origin is not None and origin != str(request.base_url).rstrip('/'):
            raise HTTPException(403,'MCP requests must come from this local TLI origin.')
    except HTTPException: raise
    except (ValueError, TypeError):
        raise HTTPException(403,'This MCP checkpoint is available only on the TLI host through localhost or a literal loopback address. LAN/public/proxy access is disabled.') from None

def browser(request):
    loopback(request)
    if request.headers.get('authorization') is not None:
        raise HTTPException(403,'Manage MCP access from the unlocked PIN browser, not a Companion or MCP credential.')
    if not S.load_pin_config().get('enabled'):
        raise HTTPException(409,'Set and unlock the owner PIN before enabling MCP access.')
    token = request.cookies.get('tli_session')
    if not token or not S.validate_session_token(token):
        raise HTTPException(401,'Unlock TLI with its owner PIN to manage MCP access.')
    return token, S.get_session_user_id(token)

def _valid(grant):
    return (grant['expires'] > time.time() and S.load_pin_config().get('enabled') is True
            and S.validate_session_token(grant['browser']) and S.get_session_user_id(grant['browser']) == grant['owner'])

def _purge():
    for key, value in list(GRANTS.items()):
        if not _valid(value): GRANTS.pop(key,None)

def summary(grant):
    return {'id':grant['id'],'scopes':list(grant['scopes']),'expires_at':iso(grant['expires']),
            'endpoint':grant['origin']+ENDPOINT,'remaining_seconds':max(0,int(grant['expires']-time.time()))}

def status(request):
    session, owner = browser(request)
    with LOCK:
        _purge()
        return {'ok':True,'protocol':UI_PROTOCOL,'enabled':any(g['browser']==session for g in GRANTS.values()),
                'grants':[summary(g) for g in GRANTS.values() if g['browser']==session], 'mcp_protocol':PROTOCOL,
                'scope':dict(_DESCRIPTIONS),'transport':'Streamable HTTP, JSON responses; loopback only',
                'limits':{'grant_seconds':TTL,'request_bytes':MAX_BODY,'response_bytes':MAX_REPLY,'requests_per_minute':60,'concurrent_requests':2},
                'persistence':'No grants or credentials are saved. PIN lock, session expiry, disconnect and server restart revoke access.'}

def grant(request, scopes):
    session, owner = browser(request)
    if not isinstance(scopes,list) or not scopes or len(scopes)>3 or any(not isinstance(s,str) or s not in SCOPES for s in scopes) or len(set(scopes))!=len(scopes):
        raise HTTPException(422,'Select one or more of the three supported read-only scopes.')
    with LOCK:
        _purge()
        if any(g['browser']==session for g in GRANTS.values()): raise HTTPException(409,'This browser already has an MCP grant. Disconnect it before changing access.')
        if len(GRANTS)>=16: raise HTTPException(429,'Too many temporary MCP grants are active. Disconnect an existing grant first.')
        credential='tlim_'+secrets.token_urlsafe(32); ident=secrets.token_hex(16)
        value={'id':ident,'owner':owner,'browser':session,'hash':hashlib.sha256(credential.encode()).hexdigest(),
               'scopes':tuple(scopes),'origin':str(request.base_url).rstrip('/'),'expires':time.time()+TTL,'requests':[],'active':set()}
        GRANTS[ident]=value
        return {'ok':True,'protocol':UI_PROTOCOL,**summary(value),'credential':credential,'mcp_protocol':PROTOCOL,
                'warning':'This credential grants only the selected reads until expiry. Keep it private. External clients control their own use/storage of returned data.'}

def revoke(request, ident):
    session, _ = browser(request)
    with LOCK:
        value=GRANTS.get(ident)
        if value and value['browser']!=session: raise HTTPException(404,'MCP grant not found for this browser.')
        GRANTS.pop(ident,None)
    return {'ok':True,'protocol':UI_PROTOCOL,'revoked':True}

def revoke_browser_session(token):
    with LOCK:
        for ident, value in list(GRANTS.items()):
            if value['browser']==token: GRANTS.pop(ident,None)

def revoke_all_grants():
    with LOCK: GRANTS.clear()

def credential(request):
    loopback(request)
    values=request.headers.getlist('authorization')
    if len(values)!=1: raise HTTPException(401,'Use the separate temporary MCP Bearer credential.')
    parts=values[0].split()
    if len(parts)!=2 or parts[0].lower()!='bearer' or not parts[1].startswith('tlim_') or len(parts[1])>128:
        raise HTTPException(401,'Invalid MCP credential. Browser and Companion credentials are not accepted.')
    key=hashlib.sha256(parts[1].encode()).hexdigest()
    with LOCK:
        _purge()
        value=next((g for g in GRANTS.values() if secrets.compare_digest(g['hash'],key)),None)
        if value is None: raise HTTPException(401,'MCP access expired or was revoked. Enable a new grant deliberately in Settings.')
        if value['origin']!=str(request.base_url).rstrip('/'): raise HTTPException(403,'This MCP grant belongs to a different local TLI address.')
        return value

def begin(value, ident):
    with LOCK:
        if GRANTS.get(value['id']) is not value or not _valid(value): raise HTTPException(401,'MCP access was revoked.')
        value['requests']=[t for t in value['requests'] if time.monotonic()-t<60]
        if len(value['requests'])>=60: raise HTTPException(429,'MCP request limit reached. Retry later deliberately.')
        if len(value['active'])>=2 or ident in value['active']: raise HTTPException(409,'An MCP request is already active. No competing request started.')
        value['active'].add(ident);value['requests'].append(time.monotonic())

def finish(value, ident):
    with LOCK: value['active'].discard(ident)

def still_valid(value):
    with LOCK:
        if GRANTS.get(value['id']) is not value or not _valid(value): raise HTTPException(401,'MCP access was revoked before the result completed.')

def tools(scopes):
    paging={'type':'object','properties':{'offset':{'type':'integer','minimum':0,'maximum':2000},'limit':{'type':'integer','minimum':1,'maximum':50}},'additionalProperties':False}
    return [{'name':name,'title':_TITLES[scope],'description':_DESCRIPTIONS[scope],
             'inputSchema':paging if scope!='health' else {'type':'object','properties':{},'additionalProperties':False},
             'annotations':{'readOnlyHint':True,'destructiveHint':False,'idempotentHint':True,'openWorldHint':False}}
            for name,scope in TOOL_SCOPES.items() if scope in scopes]

def _read(path, expected):
    try:
        with Path(path).open('rb') as handle: raw=handle.read(1024*1024+1)
    except FileNotFoundError: return None
    if len(raw)>1024*1024: raise ValueError('Registry read limit')
    def pairs(items):
        result={}
        for key,value in items:
            if key in result: raise ValueError('Duplicate registry field')
            result[key]=value
        return result
    value=json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('Invalid number')))
    if not isinstance(value,expected) or len(value)>2000: raise ValueError('Invalid registry shape')
    return value

def _text(value,limit=256):
    return ''.join(c for c in value if ord(c)>=32)[:limit] if isinstance(value,str) else None

def _registry():
    """Read only known registry paths; never use inventory()'s initializing helpers."""
    from intelligence.devices import metadata, stable_id
    host=S.read_node_config(); overlays=metadata(); rows=[]; missing=[]
    if host: rows.append({'id':'node-'+host.node_id,'kind':'computer','source':'local_node','name':host.node_name,'address':None,'room':None,'observed_at':None})
    else: missing.append('host identity')
    mesh=_read(S.MESH_DIRECTORY_PATH,dict)
    if mesh is None: missing.append('computer registry')
    else:
        for ident,d in mesh.items():
            if not isinstance(d,dict): raise ValueError('Invalid computer record')
            if host and ident==host.node_id: continue
            rows.append({'id':'node-'+ident,'kind':'computer','source':'mesh','name':_text(d.get('node_name') or d.get('display_name') or ident),
                         'address':_text(d.get('ip')),'room':None,'observed_at':d.get('last_seen')})
    home=_read(Path(S.DATA_DIR)/'home_power'/'devices.json',dict)
    shelly=_read(S.SHELLY_REGISTRY_PATH,list)
    occupied=set()
    for source, data in [('homepower',None if home is None else home.get('devices')),('shelly',shelly)]:
        if data is None: missing.append(source+' registry');continue
        if not isinstance(data,list) or len(data)>2000: raise ValueError('Invalid device registry')
        for d in data:
            if not isinstance(d,dict): raise ValueError('Invalid device record')
            address=_text(d.get('ip') or d.get('host')); relay=d.get('relay',0)
            if type(relay) is not int or not 0<=relay<=255: raise ValueError('Invalid relay identifier')
            physical=(address,relay)
            if source=='shelly' and physical in occupied: continue
            occupied.add(physical)
            ident=str(d.get('device_id') or d.get('id') or f'{address}:{relay}')
            rows.append({'id':stable_id(source,ident),'kind':'smart_device','source':source,'name':_text(d.get('name') or d.get('label') or address),
                         'address':address,'relay':relay,'room':_text(d.get('room'),120),'observed_at':None})
    if len(rows)>2000: raise ValueError('Registry entry limit')
    for row in rows:
        overlay=overlays.get(row['id'],{})
        for key in ('name','room'):
            if key in overlay: row[key]=_text(overlay[key],120)
        # Registry timestamps may be legacy or absent; never stamp them as fresh.
        if not isinstance(row.get('observed_at'),(str,int,float)) or isinstance(row.get('observed_at'),bool): row['observed_at']=None
    return rows,missing

def _health():
    from routers.dashboard_presence import _read_state
    value=_read_state(); stamp=value.get('probed_ts'); now=time.time()
    known=type(stamp) in (int,float) and math.isfinite(stamp) and 0<stamp<=now+1
    def number(v): return v if type(v) in (int,float) and math.isfinite(v) and 0<=v<=100 else None
    drives=value.get('disk_pct_by_drive')
    if not isinstance(drives,dict) or len(drives)>50: drives={}
    return {'observed_at':iso(stamp) if known else None,'freshness':'unavailable' if value.get('probe_error') else 'unknown' if not known else 'current' if now-stamp<=30 else 'stale',
            'cpu_percent':number(value.get('cpu_pct')),'ram_percent':number(value.get('ram_pct')),
            'disks':[{'resource':_text(k,256),'used_percent':number(v)} for k,v in drives.items()],
            'ai_availability':'unknown','host_availability':'this request reached TLI; it is not an AI health check',
            'scope':'Existing TLI-host observations only. No new probe or diagnosis. Prior readings may be stale or unavailable.'}

def _call(name, arguments, scopes):
    scope=TOOL_SCOPES.get(name)
    if scope not in scopes: raise HTTPException(403,'This tool is not included in the selected MCP grant.')
    if not isinstance(arguments,dict) or set(arguments)-({'offset','limit'} if scope!='health' else set()): raise ValueError('Unsupported tool arguments')
    offset=arguments.get('offset',0);limit=arguments.get('limit',25)
    if type(offset) is not int or not 0<=offset<=2000 or type(limit) is not int or not 1<=limit<=50: raise ValueError('Invalid result page')
    if scope=='health': data=_health()
    else:
        rows,missing=_registry()
        if scope=='rooms': rows=[{'id':d['id'],'name':d['name'],'kind':d['kind'],'room':d.get('room')} for d in rows]
        data={'items':rows[offset:offset+limit],'total':len(rows),'offset':offset,'has_more':offset+limit<len(rows),'unavailable_sources':missing,
              'scope':_DESCRIPTIONS[scope],'observation':'Saved registry records; no reachability, occupancy or current device status was checked.'}
    return {'ok':True,'read_at':iso(time.time()),'actions_performed':False,'inference_called':False,'data':data}

def call(name, arguments, scopes):
    # An HTTP timeout cannot free capacity while an underlying filesystem read
    # is still completing. This lease is owned by the actual worker function.
    if not _READ_SLOTS.acquire(blocking=False): raise HTTPException(429,'Two local MCP reads are already active. Retry later deliberately.')
    try: return _call(name,arguments,scopes)
    finally: _READ_SLOTS.release()
