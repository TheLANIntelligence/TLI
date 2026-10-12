"""Isolated coordinator/route tests: no household sockets, state or helpers."""
import asyncio
import copy
import ipaddress
import json
import socket
import threading
import time
from types import SimpleNamespace as NS

import pytest
from fastapi import HTTPException

import lan_discovery as D
import lan_endpoints as E
import peer_connections as C
import peer_trust as P
import tli_state as S
from routers import mesh_routes as M
from tests.test_peer_trust import peers,entry


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    monkeypatch.setattr(C,'_ROUTES',{})
    monkeypatch.setattr(C,'_CHECKS',{})
    monkeypatch.setattr(C,'_HINT_CHECKS',{})
    monkeypatch.setattr(C,'_INFLIGHT',{})
    monkeypatch.setattr(C,'_SLOTS',threading.BoundedSemaphore(4))
    monkeypatch.setattr(C,'_EMIT',None)
    monkeypatch.setattr(C,'_NETWORK_CHANGED_AT',0)
    monkeypatch.setattr(E,'_HINTS',{})
    monkeypatch.setattr(E,'_DNS',{})
    monkeypatch.setattr(E,'_VERIFIED',{})
    monkeypatch.setattr(D,'_presence_broadcast_fn',None)
    monkeypatch.setattr(D,'_stop_event',threading.Event())
    monkeypatch.setattr(D,'_adapter_networks',lambda:[('192.168.2.10',ipaddress.IPv4Network('192.168.2.0/24'))])
    monkeypatch.setattr(D,'_status',{'enabled':True,'mdns':'ready','udp':'ready'})
    monkeypatch.setattr(D,'_scan',{'state':'idle','checked':0,'total':0})
    monkeypatch.setattr(D,'_last_scan',0)
    monkeypatch.setattr(D,'_passive_writes',{})
    monkeypatch.setattr(D,'_passive_budget',{'tokens':16.0,'at':time.monotonic()})


def ready(peer_id):
    return {'online':True,'node_id':peer_id,'ready_grants':['messages'],'local_grants':['messages'],'remote_grants':['messages']}


def test_multiple_sources_merge_routes_and_preserve_stable_origin(peers,monkeypatch):
    before=S.load_mesh_directory()['peer-b']
    D._upsert_peer('peer-b','Hint','192.168.2.20',8443,endpoint_origin='https://workshop.local:8443',source='mdns',interface='192.168.2.10')
    D._upsert_peer('peer-b','Hint','10.2.3.5',8443,endpoint_origin='https://workshop.local:8443',source='invitation')
    D._upsert_peer('peer-b','Hint','192.168.2.21',8443,source='udp')
    after=S.load_mesh_directory()['peer-b']; hint=after.pop('discovery')
    assert after==before and hint['origin']=='https://workshop.local:8443'
    found=C.discovery('peer-b')
    assert found['candidate_count']==3 and found['sources']==['invitation','mdns','udp']
    monkeypatch.setattr(E,'_dns',lambda *args:[])
    assert set(E.resolve('workshop.local',8443))=={'192.168.2.20','10.2.3.5','192.168.2.21'}
    for row in C._ROUTES['peer-b'].values(): row['expires']=0
    assert C.discovery('peer-b')['candidate_count']==0


def test_route_registry_rejects_public_hints_and_does_not_refresh_trust(peers):
    before=S.MESH_DIRECTORY_PATH.read_bytes()
    for address in ['8.8.8.8','127.0.0.1','169.254.3.4','not-ip']:
        with pytest.raises(ValueError): D._upsert_peer('peer-b','Hint',address,8443)
        C.observe('peer-b',address,8443)
    assert not C._ROUTES and S.MESH_DIRECTORY_PATH.read_bytes()==before


def test_unsigned_intake_limit_preserves_every_existing_identity_and_history(peers,monkeypatch):
    directory=S.load_mesh_directory()
    directory.update({f'pending-{i}':{'device_id':f'pending-{i}','status':'pending'} for i in range(D.MAX_PENDING_DISCOVERIES)})
    directory['blocked']={'status':'blocked','notes':'Preserve local history'}
    S.save_mesh_directory(directory)
    before=S.MESH_DIRECTORY_PATH.read_bytes()
    monkeypatch.setattr(S,'save_mesh_directory',lambda value:pytest.fail('Full intake must not write new unsigned peers'))
    for i in range(32):
        assert not D._upsert_peer(f'flood-{i}','Unsigned','192.168.2.30',8443,source='udp')
    assert S.MESH_DIRECTORY_PATH.read_bytes()==before and C._ROUTES=={}


def test_passive_write_budget_coalesces_duplicates_but_keeps_live_route_hints(peers,monkeypatch):
    writes=[]; save=S.save_mesh_directory
    monkeypatch.setattr(S,'save_mesh_directory',lambda value:(writes.append(copy.deepcopy(value)),save(value))[-1])
    clock=[time.monotonic()]
    monkeypatch.setattr(D,'time',NS(monotonic=lambda:clock[0]))
    trust=S.load_mesh_directory()['peer-b']
    D._upsert_peer('peer-b','Hint','192.168.2.20',8443,source='udp',generation='a'*24)
    for i in range(32):
        D._upsert_peer('peer-b','Hint','192.168.2.20',8443,source='udp',generation=f'{i:024x}')
    assert len(writes)==1
    assert C.discovery('peer-b')['candidates'][0]['generation']==f'{31:024x}'
    for i in range(32):
        D._upsert_peer(f'flood-{i}','Unsigned','192.168.2.30',8443,source='mdns')
    assert len(writes)==16 and len(S.load_mesh_directory())==16
    after=S.load_mesh_directory()['peer-b']; after.pop('discovery'); assert after==trust
    # Exhausted disk budget cannot hide a new route for an existing reviewed peer.
    D._upsert_peer('peer-b','Hint','192.168.2.21',8443,source='udp')
    assert len(writes)==16 and C.discovery('peer-b')['candidate_count']==2
    clock[0]+=60
    D._upsert_peer('peer-b','Hint','192.168.2.20',8443,source='udp')
    assert len(writes)==17


def test_owner_invitation_bypasses_passive_capacity_without_checking_connections(peers,monkeypatch):
    directory=S.load_mesh_directory()
    directory.update({f'pending-{i}':{'status':'pending'} for i in range(D.MAX_PENDING_DISCOVERIES)})
    S.save_mesh_directory(directory)
    D._passive_budget['tokens']=0
    monkeypatch.setattr(C,'schedule',lambda *a,**kw:pytest.fail('Invitation import has no network side effect'))
    assert D._upsert_peer('invited','Invited computer','192.168.2.33',8443,source='invitation')
    assert S.load_mesh_directory()['invited']['status']=='pending'


def test_cached_lists_never_probe_or_invent_online_from_discovery(peers,monkeypatch):
    from routers import system_routes
    monkeypatch.setattr(P,'check_status',lambda *args:pytest.fail('No list network I/O'))
    monkeypatch.setattr(system_routes,'agent_health',lambda:{'online':True})
    D._upsert_peer('unreviewed','Found computer','192.168.2.99',8443)
    peers_list=M.get_lan_peers('owner')['peers']
    assert all(row['online'] is None for row in peers_list)
    assert all(row['connection']['protocol']=='tli-connections-v1' and row['connection']['schema_version']==1 for row in peers_list)
    unknown=next(row for row in peers_list if row['id']=='unreviewed')
    assert unknown['connection']['state']=='review_required' and unknown['discovered_recently']
    assert len(M.mesh_health('owner')['nodes'])==3


def test_explicit_check_coalesces_parallel_requests_and_fresh_cache(peers,monkeypatch):
    entered,release=threading.Event(),threading.Event(); calls=[]
    def check(peer):
        calls.append(peer); entered.set(); assert release.wait(2); return ready(peer)
    monkeypatch.setattr(P,'check_status',check)
    first=C.schedule('peer-b'); assert entered.wait(1)
    assert C.schedule('peer-b',force=True) is first
    assert C.snapshot('peer-b')['state']=='checking'
    release.set(); assert first.wait(2)
    assert C.check('peer-b')['ok'] and calls==['peer-b']
    assert C.snapshot('peer-b')['capabilities']['messages']['state']=='ready'
    C._CHECKS['peer-b']['expires']=0
    stale=C.snapshot('peer-b')
    assert stale['online'] is None and stale['ready_grants']==[] and not stale['fresh']


def test_explicit_failure_is_structured_and_backed_off(peers,monkeypatch):
    calls=[]
    def check(peer):
        calls.append(peer); raise HTTPException(504,{'code':'peer_timeout','message':'Synthetic timeout'})
    monkeypatch.setattr(P,'check_status',check)
    result=C.check('peer-b')
    assert not result['ok'] and result['connection']['state']=='unreachable'
    assert result['connection']['reason']['code']=='peer_timeout'
    assert result['connection']['capabilities']['messages']['state']=='not_checked'
    assert result['connection']['capabilities']['observe']['state']=='not_checked'
    assert result['connection']['retry_after_seconds']>0
    assert C.schedule('peer-b') is None and C.schedule('peer-b',force=True) is None
    assert calls==['peer-b']
    C._CHECKS['peer-b']['next']=0
    C.schedule('peer-b').wait(2)
    assert C._CHECKS['peer-b']['failures']==2 and C._CHECKS['peer-b']['next']-time.monotonic()>9


@pytest.mark.parametrize('change',['generation','route','legacy_quiet'])
def test_return_advertisement_wakes_failed_check_before_old_backoff(peers,monkeypatch,change):
    calls=[]
    def failed(peer):
        calls.append(peer); raise HTTPException(504,{'code':'peer_timeout','message':'Synthetic timeout'})
    monkeypatch.setattr(P,'check_status',failed)
    C.observe('peer-b','192.168.2.20',8443,source='mdns',generation='a'*24)
    assert not C.check('peer-b')['ok']
    cached=C._CHECKS['peer-b']; cached.update(next=time.monotonic()+120,last_attempt=time.monotonic()-3)
    # Ordinary duplicate discovery cannot reset an unavailable peer's backoff.
    C.observe('peer-b','192.168.2.20',8443,source='mdns',generation='a'*24)
    assert calls==['peer-b'] and cached['next']-time.monotonic()>119
    if change=='legacy_quiet':
        for route in C._ROUTES['peer-b'].values(): route['observed']=time.monotonic()-46
    entered,release=threading.Event(),threading.Event()
    def recovered(peer):
        calls.append(peer); entered.set(); assert release.wait(2); return ready(peer)
    monkeypatch.setattr(P,'check_status',recovered)
    C.observe('peer-b','192.168.2.21' if change=='route' else '192.168.2.20',8443,source='mdns',
              generation='b'*24 if change=='generation' else 'a'*24)
    assert entered.wait(1) and len(calls)==2
    event=C._INFLIGHT['peer-b']['event']; release.set(); assert event.wait(2)
    assert C.snapshot('peer-b')['state']=='connected'


def test_discovery_wakes_are_rate_limited_and_do_not_grant_authority(peers,monkeypatch):
    monkeypatch.setattr(P,'check_status',lambda peer:(_ for _ in ()).throw(HTTPException(504,{'code':'peer_timeout'})))
    C.check('peer-b')
    cached=C._CHECKS['peer-b']; cached.update(next=time.monotonic()+120,last_attempt=time.monotonic()-3)
    calls=[]
    def scheduled(peer):
        P.trusted(peer); calls.append(peer)
    monkeypatch.setattr(C,'schedule',scheduled)
    C.observe('peer-b','192.168.2.20',8443,source='mdns',generation='a'*24)
    assert calls==['peer-b']
    cached['next']=time.monotonic()+120
    for index in range(20):
        C.observe('peer-b','192.168.2.20',8443,source='mdns',generation=f'{index:024x}')
    assert calls==['peer-b'] and cached['next']-time.monotonic()>119
    C._HINT_CHECKS.clear()
    C.observe('peer-b','192.168.2.21',8443,source='invitation',generation='c'*24)
    C.observe('unknown','192.168.2.22',8443,source='udp',generation='c'*24)
    assert calls==['peer-b'] and cached['next']-time.monotonic()>119
    directory=S.load_mesh_directory(); directory['peer-b']['status']='blocked'; S.save_mesh_directory(directory)
    C.observe('peer-b','192.168.2.23',8443,source='mdns',generation='d'*24)
    assert calls==['peer-b'] and C.snapshot('peer-b')['state']=='review_required'


def test_advertisement_forwards_only_a_valid_optional_generation(peers,monkeypatch):
    for generation in ['a'*24,'invalid\nvalue',None]:
        D._handle_beacon(json.dumps({'tli':1,'id':'peer-b','name':'Hint','port':8443,
                                    'discovery_generation':generation}).encode(),'192.168.2.20')
        rows=C.discovery('peer-b')['candidates']
        assert rows[0]['generation']==('a'*24 if generation=='a'*24 else None)
        assert 'observed' not in rows[0]


def test_inflight_revocation_and_network_change_discard_connected_state(peers,monkeypatch):
    entered,release=threading.Event(),threading.Event()
    def check(peer): entered.set(); release.wait(2); return ready(peer)
    monkeypatch.setattr(P,'check_status',check)
    event=C.schedule('peer-b'); assert entered.wait(1)
    C.network_changed()
    directory=S.load_mesh_directory(); directory['peer-b']['status']='blocked'; S.save_mesh_directory(directory)
    release.set(); assert event.wait(2)
    assert not C._CHECKS and C.snapshot('peer-b')['state']=='review_required'
    with pytest.raises(HTTPException): C.schedule('peer-b')


@pytest.mark.parametrize('count',[0,2])
def test_node_connection_uses_catalog_only_and_retains_explicit_selection(peers,monkeypatch,count):
    import lan_inference
    card=copy.deepcopy(peers.b); card['capabilities']=['inference_v1']; card.pop('signature')
    card['signature']=peers.key_b.sign(P.canonical(card)).hex()
    S.save_mesh_directory({'peer-b':entry(card,grants=['inference'])})
    calls=[]
    monkeypatch.setattr(P,'check_status',lambda *args:pytest.fail('Node has no full-host status route'))
    monkeypatch.setattr(lan_inference,'models',lambda peer:calls.append(peer) or {'resources':[{}]*count})
    before=S.MESH_DIRECTORY_PATH.read_bytes()
    result=C.check('peer-b')
    assert result['ok'] and calls==['peer-b']
    assert result['connection']['capabilities']['inference']=={'state':'ready' if count else 'no_model','models':count}
    assert result['connection']['capabilities']['messages']['state']=='permission_required'
    assert S.MESH_DIRECTORY_PATH.read_bytes()==before


def test_global_concurrency_is_bounded(peers,monkeypatch):
    release=threading.Event(); calls=[]
    monkeypatch.setattr(P,'trusted',lambda peer:({'peer_trust':{'grants':['messages']}},peers.b,peer))
    def check(peer): calls.append(peer); release.wait(2); return ready(peer)
    monkeypatch.setattr(P,'check_status',check)
    events=[C.schedule(str(index)) for index in range(12)]
    assert sum(event is not None for event in events)==4
    release.set()
    for event in events:
        if event: assert event.wait(2)
    assert len(calls)==4


def test_dns_wait_is_bounded_and_singleflight(monkeypatch):
    entered,release=threading.Event(),threading.Event(); calls=[]
    def resolve(*args):
        calls.append(args); entered.set(); release.wait(3); return [(socket.AF_INET,socket.SOCK_STREAM,6,'',('192.168.2.30',443))]
    monkeypatch.setattr(E.socket,'getaddrinfo',resolve)
    started=time.monotonic()
    assert E.resolve('slow-dns.local',443)==[]
    assert time.monotonic()-started<.8 and entered.is_set()
    assert E.resolve('slow-dns.local',443)==[] and len(calls)==1
    E.invalidate(); release.set()
    for pending in list(E._DNS_PENDING.values()): assert pending[0].wait(1)
    assert not E._DNS  # result from the old adapter generation was discarded


def test_tls_route_failure_tries_next_before_any_authenticated_request(monkeypatch):
    calls=[]
    class Sock:
        def settimeout(self,value): pass
        def close(self): pass
        def shutdown(self,value): pass
    def dial(target,timeout,source):
        calls.append(('dial',target[0],timeout))
        if target[0].endswith('.20'): raise TimeoutError()
        return Sock()
    conn=E.LANHTTPSConnection('workshop.local',8443,timeout=5)
    conn._context=NS(wrap_socket=lambda raw,server_hostname:raw)
    conn.verify_peer=lambda transport:calls.append(('proof',transport.route_address))
    monkeypatch.setattr(E,'resolve',lambda *args:['192.168.2.20','192.168.2.21'])
    monkeypatch.setattr(E.socket,'create_connection',dial)
    conn.connect()
    assert [row[0] for row in calls]==['dial','dial','proof']
    assert calls[0][2]<=1 and conn.route_address=='192.168.2.21'
    assert E._VERIFIED[('workshop.local',8443)][0]=='192.168.2.21'
    conn.close()


def test_fixed_pairing_route_never_resolves_or_fails_over(monkeypatch):
    conn=E.LANHTTPSConnection('workshop.local',8443,timeout=2)
    conn.route_addresses=['192.168.2.77']
    monkeypatch.setattr(E,'resolve',lambda *args:pytest.fail('Transcript route is fixed'))
    calls=[]
    def dial(target,*args): calls.append(target); raise TimeoutError()
    monkeypatch.setattr(E.socket,'create_connection',dial)
    with pytest.raises(TimeoutError): conn.connect()
    assert calls==[('192.168.2.77',8443)]
    conn.route_addresses=['8.8.8.8']
    with pytest.raises(ValueError): conn.connect()


def test_mismatched_identity_never_becomes_a_verified_route(monkeypatch):
    class Sock:
        def settimeout(self,value): pass
        def close(self): pass
        def shutdown(self,value): pass
    conn=E.LANHTTPSConnection('workshop.local',443,timeout=2)
    conn._context=NS(wrap_socket=lambda raw,server_hostname:raw)
    monkeypatch.setattr(E,'resolve',lambda *args:['192.168.2.20','192.168.2.21'])
    monkeypatch.setattr(E.socket,'create_connection',lambda *args:Sock())
    def reject(transport): raise HTTPException(409,{'code':'peer_identity_changed'})
    conn.verify_peer=reject
    with pytest.raises(HTTPException): conn.connect()
    assert not E._VERIFIED


def test_identity_mismatch_is_not_hidden_by_dead_last_route(monkeypatch):
    import ssl
    conn=E.LANHTTPSConnection('workshop.local',443,timeout=2)
    monkeypatch.setattr(E,'resolve',lambda *args:['192.168.2.20','192.168.2.21'])
    def dial(target,*args):
        if target[0].endswith('.20'):
            raise ssl.SSLCertVerificationError('Synthetic changed leaf')
        raise ConnectionRefusedError()
    monkeypatch.setattr(E.socket,'create_connection',dial)
    with pytest.raises(ssl.SSLCertVerificationError): conn.connect()


@pytest.mark.parametrize('kind,code',[
    ('resolution','peer_resolution_failed'),('refused','peer_listener_refused'),
    ('timeout','peer_timeout'),('certificate','peer_certificate_changed')])
def test_transport_errors_keep_actionable_reason(peers,monkeypatch,kind,code):
    import ast,ssl
    from pathlib import Path
    tree=ast.parse(Path(P.__file__).read_text(encoding='utf-8'))
    fn=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='_exchange')
    namespace=dict(vars(P)); exec(compile(ast.Module(body=[fn],type_ignores=[]),P.__file__,'exec'),namespace)
    errors={'resolution':E.RouteResolutionError(),'refused':ConnectionRefusedError(),
            'timeout':TimeoutError(),'certificate':ssl.SSLCertVerificationError()}
    class Connection:
        def __init__(self,*args,**kwargs): pass
        def connect(self): raise errors[kind]
        def close(self): pass
        def request(self,*args,**kwargs): pytest.fail('No authenticated request before successful identity check')
    monkeypatch.setattr(P.http.client,'HTTPSConnection',Connection)
    with pytest.raises(HTTPException) as error:
        namespace['_exchange'](peers.b,'POST','/sensitive',b'private',{'Authorization':'secret'},lambda:None)
    assert error.value.detail['code']==code


def test_preferred_verified_route_survives_empty_discovery_until_expiry(monkeypatch):
    monkeypatch.setattr(E,'_dns',lambda *args:[])
    E.note_verified('workshop.local',443,'192.168.2.20')
    assert E.resolve('workshop.local',443)==['192.168.2.20']
    E._VERIFIED[('workshop.local',443)]=('192.168.2.20',0)
    assert E.resolve('workshop.local',443)==[]


def test_review_required_error_is_not_reported_as_network_failure(peers,monkeypatch):
    def check(peer): raise HTTPException(409,{'code':'review_required','message':'Review changed grant'})
    monkeypatch.setattr(P,'check_status',check)
    result=C.check('peer-b')['connection']
    assert result['state']=='review_required' and result['online'] is None


def test_udp_binds_each_actual_private_listener_adapter(peers,monkeypatch):
    calls=[]
    class Sock:
        def setsockopt(self,*args): pass
        def settimeout(self,*args): pass
        def bind(self,address): calls.append(('bind',address))
        def sendto(self,body,address): calls.append(('send',json.loads(body),address))
        def close(self): pass
    monkeypatch.setattr(D,'_adapter_networks',lambda:[('192.168.2.10',ipaddress.IPv4Network('192.168.2.0/24')),('10.1.0.2',ipaddress.IPv4Network('10.1.0.0/16'))])
    monkeypatch.setattr(D,'_listener_addresses',lambda:['192.168.2.10','10.1.0.2'])
    monkeypatch.setattr(D.socket,'socket',lambda *args:Sock())
    monkeypatch.setattr(D,'_make_beacon',lambda:json.dumps({'port':9443}).encode())
    D._broadcast_once()
    assert [row[1] for row in calls if row[0]=='bind']==[('192.168.2.10',0),('10.1.0.2',0)]
    assert [row[2] for row in calls if row[0]=='send']==[('192.168.2.255',47474),('10.1.255.255',47474)]


@pytest.mark.parametrize('transition',['resume','adapter'])
def test_watcher_invalidates_routes_and_rebinds_after_transition(monkeypatch,transition):
    calls=[]; iteration=[0]
    clock=iter([100,100,120 if transition=='resume' else 105])
    monkeypatch.setattr(D,'time',NS(time=lambda:next(clock),monotonic=lambda:0))
    monkeypatch.setattr(D,'_stop_event',NS(is_set=lambda:iteration[0]>=2,wait=lambda seconds:iteration.__setitem__(0,iteration[0]+1)))
    monkeypatch.setattr(D,'_listen_thread',NS(is_alive=lambda:True))
    monkeypatch.setattr(D,'_refresh_mdns',lambda force=False:calls.append(('refresh',force)))
    monkeypatch.setattr(D,'_broadcast_once',lambda:calls.append(('broadcast',)))
    monkeypatch.setattr(C,'network_changed',lambda:calls.append(('invalidate',)))
    monkeypatch.setattr(D,'_adapter_networks',lambda:[('192.168.2.77' if transition=='adapter' and iteration[0] else '192.168.2.10',ipaddress.IPv4Network('192.168.2.0/24'))])
    previous_generation=D._advert_generation
    D._start_mdns()
    assert D._advert_generation != previous_generation
    assert calls==[('refresh',False),('invalidate',),('broadcast',),('refresh',True)]


def test_node_watcher_rebinds_same_adapter_after_resume(monkeypatch):
    import node_discovery as N
    calls=[]; iteration=[0]; clock=iter([100,100,120])
    monkeypatch.setattr(N,'time',NS(time=lambda:next(clock),monotonic=lambda:0))
    monkeypatch.setattr(N,'private_adapters',lambda:['192.168.2.20'])
    monkeypatch.setattr(E,'invalidate',lambda:calls.append(('invalidate',)))
    advertiser=N.Advertiser({})
    advertiser.stop_event=NS(is_set=lambda:iteration[0]>=2,wait=lambda seconds:iteration.__setitem__(0,iteration[0]+1))
    advertiser.refresh=lambda force=False:calls.append(('refresh',force)) or True
    previous_generation=advertiser.generation
    advertiser._loop()
    assert advertiser.generation != previous_generation
    assert calls==[('refresh',False),('invalidate',),('refresh',True)]


def test_startup_does_not_scan_or_mutate_firewall_and_loopback_does_not_advertise(monkeypatch):
    import ast,inspect
    # Test the original lifecycle, since the suite disables main's startup hooks.
    tree=ast.parse(__import__('pathlib').Path(D.__file__).read_text(encoding='utf-8'))
    fn=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='start')
    namespace=dict(vars(D)); exec(compile(ast.Module(body=[fn],type_ignores=[]),D.__file__,'exec'),namespace)
    namespace['_listener_addresses']=lambda:[]
    namespace['_mdns_thread']=None
    namespace['threading']=NS(Thread=lambda **kwargs:pytest.fail('Loopback must not start discovery'))
    namespace['start']()
    assert D._status['reason']=='no_private_tls_listener'
    source=inspect.getsource(fn) if False else ast.unparse(fn)
    assert '_try_open_firewall' not in source and 'scan' not in source


def test_explicit_diagnostic_scan_is_bounded_and_throttled(peers,monkeypatch):
    calls=[]
    monkeypatch.setattr(D,'_adapter_networks',lambda:[('192.168.2.1',ipaddress.IPv4Network('192.168.2.0/30'))])
    monkeypatch.setattr(D,'_probe_ip',lambda *args:calls.append(args))
    result=D.request_scan('192.168.2.1',[9443])
    D._scan_thread.join(2)
    assert result['total']==1 and calls==[('192.168.2.2','192.168.2.1',9443)]
    assert D.status()['scan']['state']=='complete'
    with pytest.raises(HTTPException) as err: D.request_scan('192.168.2.1',[9443])
    assert err.value.status_code==429
    with pytest.raises(HTTPException): D.request_scan('8.8.8.8')
    monkeypatch.setattr(D,'_adapter_networks',lambda:[('10.0.0.1',ipaddress.IPv4Network('10.0.0.0/16'))])
    with pytest.raises(HTTPException): D.request_scan('10.0.0.1')


def test_sse_overflow_becomes_reconciliation_event():
    queue=asyncio.Queue(maxsize=1); queue.put_nowait('old')
    M._enqueue_presence(queue,'new')
    assert json.loads(queue.get_nowait())=={'type':'directory_changed','resync':True,'protocol':'tli-connections-v1','schema_version':1}


def test_dashboard_does_not_count_permission_as_online(peers,monkeypatch):
    from routers import dashboard_presence
    assert dashboard_presence._mesh_snapshot({'id':'local-a'})['online_peer_count']==0
    monkeypatch.setattr(P,'check_status',ready)
    C.check('peer-b')
    assert dashboard_presence._mesh_snapshot({'id':'local-a'})['online_peer_count']==1
