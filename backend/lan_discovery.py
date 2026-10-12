"""Passive LAN discovery. Unsigned routes are hints, never peer authority.

DNS-SD and per-adapter legacy UDP run only for a private TLS listener. Subnet
diagnostics require an explicit request; startup never changes firewall rules.
"""
from __future__ import annotations

import ipaddress
import json
import secrets
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait
from urllib.parse import urlsplit

import tli_state as S
import lan_endpoints
import peer_connections as C

BEACON_PORT = 47474
BEACON_INTERVAL = 30
BEACON_VERSION = '1'
TLI_HTTP_PORT = 8000
SERVICE_TYPE = '_tli._tcp.local.'
_stop_event = threading.Event()
_broadcast_thread = _listen_thread = _mdns_thread = _scan_thread = None
_zeroconf = _service = _browser = _mdns_signature = None
_mdns_lock = threading.RLock()
_state_lock = threading.RLock()
_presence_broadcast_fn = None
_status = {'enabled':False, 'mdns':'not_started', 'udp':'not_started', 'reason':'not_started'}
_scan = {'state':'idle', 'checked':0, 'total':0}
_last_scan = 0.0
_advert_generation = secrets.token_hex(12)
_passive_writes = {}
_passive_budget = {'tokens':16.0, 'at':time.monotonic()}
MAX_PENDING_DISCOVERIES = 512


def set_presence_broadcast(fn):
    global _presence_broadcast_fn
    _presence_broadcast_fn = fn


def _notify():
    if _presence_broadcast_fn:
        try:
            _presence_broadcast_fn({'type':'directory_changed'})
        except Exception:
            pass


def _adapter_networks():
    import psutil
    result = []
    stats = psutil.net_if_stats()
    for name, addresses in psutil.net_if_addrs().items():
        if name in stats and not stats[name].isup:
            continue
        for address in addresses:
            if address.family == socket.AF_INET and lan_endpoints.private_ip(address.address) and address.netmask:
                try:
                    result.append((address.address, ipaddress.IPv4Network(f'{address.address}/{address.netmask}', strict=False)))
                except ValueError:
                    pass
    return sorted(set(result), key=lambda row:row[0])


def _interface_for(address):
    try:
        value = ipaddress.IPv4Address(address)
        return next((ip for ip, network in _adapter_networks() if value in network), None)
    except (ValueError, OSError):
        return None


def _listener_addresses():
    from tls_cert import lan_listener_addresses
    return lan_listener_addresses() if S.TLS_ENABLED else []


def status():
    with _state_lock:
        value = dict(_status)
        value['scan'] = dict(_scan)
    value.update(secure_port=S.server_port(), automatic_scan=False, automatic_firewall_changes=False,
                 adapters=[{'address':ip,'subnet':str(net)} for ip,net in _adapter_networks()])
    return value


def _make_beacon():
    cfg = S.load_node_config()
    from tls_cert import stable_lan_origins
    stable = stable_lan_origins(S.server_port())
    payload = {'tli':1,'v':BEACON_VERSION,'id':cfg.node_id,'name':cfg.node_name,
               'port':S.server_port(),'tls':bool(S.TLS_ENABLED),'endpoint_protocol':'tli-endpoint-v1',
               'discovery_generation':_advert_generation}
    if stable:
        payload['origin'] = stable[0]
    return json.dumps(payload,separators=(',',':')).encode()


def _broadcast_once():
    data, successes = _make_beacon(), 0
    active = set(_listener_addresses())
    for address, network in _adapter_networks():
        if address not in active:
            continue
        sock = socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
        try:
            sock.setsockopt(socket.SOL_SOCKET,socket.SO_BROADCAST,1)
            sock.settimeout(1)
            sock.bind((address,0))
            sock.sendto(data,(str(network.broadcast_address),BEACON_PORT))
            successes += 1
        except OSError:
            pass
        finally:
            sock.close()
    with _state_lock:
        _status['udp_broadcast'] = 'ready' if successes else 'unavailable'


def _broadcast_loop():
    while not _stop_event.is_set():
        _broadcast_once()
        _stop_event.wait(BEACON_INTERVAL)


def _handle_beacon(data,sender_ip):
    try:
        if len(data)>4096:
            return
        payload=json.loads(data.decode())
        if not isinstance(payload,dict) or payload.get('tli')!=1:
            return
        _upsert_peer(payload.get('id'),payload.get('name','Unknown TLI computer'),sender_ip,
                     payload.get('port',8000),endpoint_origin=payload.get('origin'),source='udp',
                     interface=_interface_for(sender_ip),generation=payload.get('discovery_generation'))
    except (ValueError,TypeError,AttributeError):
        return


def _upsert_peer(peer_id,peer_name,ip,port,ai_advertisement=None,endpoint_origin=None,
                 advertised_capabilities=None,*,source='legacy',interface=None,ttl=120,generation=None):
    """Merge route hints without erasing a richer source or reviewed authority."""
    ip = lan_endpoints.private_ip(ip)
    if (not ip or not isinstance(peer_id,str) or not 1<=len(peer_id)<=128 or not isinstance(peer_name,str)
            or not 1<=len(peer_name)<=128 or type(port) is not int or not 1<=port<=65535):
        raise ValueError('Invalid discovery identity or private route')
    origin = None
    if isinstance(endpoint_origin,str):
        try:
            canonical = lan_endpoints.canonical_origin(endpoint_origin)
            if urlsplit(canonical).port == port:
                origin = canonical
        except ValueError:
            pass
    with S.MESH_DIRECTORY_LOCK:
        if peer_id==S.load_node_config().node_id:
            return False
        directory=S.load_mesh_directory()
        existing=directory.get(peer_id,{})
        is_new=peer_id not in directory
        # Preserve every existing record, including blocked identities and
        # history. An unsigned advertiser cannot grow persistent state forever.
        if is_new and source != 'invitation' and sum(
                1 for row in directory.values() if not row.get('peer_trust') and row.get('status','pending')=='pending'
        ) >= MAX_PENDING_DISCOVERIES:
            return False
        observed=dict(existing.get('discovery') or {})
        observed.update(name=peer_name,ip=ip,port=port,observed_at=S.now_iso(),verified=False)
        if advertised_capabilities==['inference_v1']:
            observed['capabilities']=['inference_v1']
        if origin:
            observed['origin']=origin
        if ai_advertisement is not None:
            observed.update(ai_healthy=ai_advertisement.get('ai_healthy') is True,has_ai=ai_advertisement.get('has_ai') is True)
        existing['discovery']=observed
        if not existing.get('peer_trust'):
            display=peer_name if existing.get('status','pending')=='pending' else existing.get('display_name') or peer_name
            existing.update(device_id=peer_id,display_name=display,ip=ip,tli_port=port,last_seen=S.now_iso())
            existing.setdefault('status','pending'); existing.setdefault('is_host',False); existing.setdefault('labels',[])
        persist = True
        if source in {'udp','mdns'}:
            now = time.monotonic()
            fingerprint = json.dumps({key:value for key,value in observed.items() if key!='observed_at'},sort_keys=True,separators=(',',':'))
            previous = _passive_writes.get(peer_id) if not is_new else None
            tokens = min(16.0,_passive_budget['tokens']+max(0,now-_passive_budget['at'])*4)
            _passive_budget.update(tokens=tokens,at=now)
            persist = not (previous and now-previous[0]<60 and previous[1]==fingerprint) and tokens>=1
            if persist:
                _passive_budget['tokens'] -= 1
                _passive_writes[peer_id] = (now,fingerprint)
                while len(_passive_writes)>1024:
                    del _passive_writes[next(iter(_passive_writes))]
        if persist:
            directory[peer_id]=existing
            S.save_mesh_directory(directory)
        elif is_new:
            return False
    # A less informative legacy beacon may still supply a new private route
    # for a previously observed/reviewed name. The name/key/pin are not updated.
    route_origin = origin or observed.get('origin') or (existing.get('peer_trust') or {}).get('card',{}).get('origin')
    C.observe(peer_id,ip,port,origin=route_origin,source=source,interface=interface,ttl=ttl,generation=generation)
    if persist:
        _notify()
    return is_new


def _probe_ip(ip_str,my_ip,port=TLI_HTTP_PORT):
    """Credential-free, bounded legacy hint used only by requested diagnostics."""
    if ip_str==my_ip or _stop_event.is_set():
        return
    import http.client
    import ssl
    context=ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname=False; context.verify_mode=ssl.CERT_NONE
    conn=http.client.HTTPSConnection(ip_str,port,timeout=.5,context=context)
    def expire():
        try:
            if conn.sock:
                conn.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
    timer=threading.Timer(1.2,expire); timer.daemon=True; timer.start()
    try:
        conn.request('GET','/agent/ping',headers={'Accept':'application/json'})
        response=conn.getresponse(); raw=response.read(4097)
        if response.status!=200 or len(raw)>4096:
            return
        data=json.loads(raw)
        if isinstance(data,dict) and data.get('ok'):
            _upsert_peer(data.get('node_id'),data.get('node_name') or data.get('hostname') or ip_str,
                         ip_str,port,ai_advertisement=data,source='diagnostic_scan',interface=my_ip)
    except (OSError,ValueError,TypeError,http.client.HTTPException):
        pass
    finally:
        timer.cancel(); conn.close()


def request_scan(adapter,ports=None):
    """One explicitly selected active adapter, at most 256 hosts / 3 ports."""
    global _scan_thread,_last_scan,_scan
    from fastapi import HTTPException
    networks=dict(_adapter_networks())
    if adapter not in networks:
        raise HTTPException(400,{'code':'invalid_adapter','message':'Choose a current private adapter.'})
    network=networks[adapter]
    if network.num_addresses>256:
        raise HTTPException(400,{'code':'scan_too_large','message':'Use discovery or a connection invitation on subnets larger than 256 addresses.'})
    ports=ports if ports is not None else [S.server_port()]
    if not isinstance(ports,list) or not 1<=len(ports)<=3 or any(type(p) is not int or not 1<=p<=65535 for p in ports):
        raise HTTPException(400,{'code':'invalid_ports','message':'Choose up to three listener ports.'})
    with _state_lock:
        if _scan.get('state')=='running':
            return dict(_scan)
        if _last_scan and time.monotonic()-_last_scan<60:
            raise HTTPException(429,{'code':'scan_rate_limited','message':'Wait a minute before starting another diagnostic scan.'})
        if not _status['enabled']:
            raise HTTPException(409,{'code':'lan_disabled','message':'Enable a private HTTPS listener first.'})
        targets=[(str(ip),p) for ip in network.hosts() if str(ip)!=adapter for p in dict.fromkeys(ports)]
        _scan={'state':'running','checked':0,'total':len(targets),'adapter':adapter,'ports':ports,'started_at':S.now_iso()}
        _last_scan=time.monotonic()
    def run():
        deadline=time.monotonic()+15
        def probe(target):
            if _stop_event.is_set() or time.monotonic()>=deadline:
                return
            _probe_ip(target[0],adapter,target[1])
            with _state_lock:
                _scan['checked']+=1
        with ThreadPoolExecutor(max_workers=16,thread_name_prefix='tli-explicit-scan') as pool:
            futures=[pool.submit(probe,target) for target in targets]
            wait(futures,timeout=16.5)
        with _state_lock:
            _scan.update(state='complete' if _scan['checked']==_scan['total'] else 'partial',finished_at=S.now_iso())
        _notify()
    _scan_thread=threading.Thread(target=run,daemon=True,name='tli-explicit-scan')
    _scan_thread.start()
    return dict(_scan)


class _DiscoveryListener:
    def add_service(self,zeroconf,service_type,name):
        self.update_service(zeroconf,service_type,name)

    def update_service(self,zeroconf,service_type,name):
        try:
            info=zeroconf.get_service_info(service_type,name,timeout=1500)
            if info is None:
                return
            properties={k.decode('utf-8'):v.decode('utf-8') for k,v in info.properties.items()
                        if isinstance(k,bytes) and isinstance(v,bytes) and len(k)<64 and len(v)<512}
            if properties.get('tls')!='1':
                return
            capabilities=json.loads(properties.get('capabilities','null'))
            for address in info.parsed_addresses()[:8]:
                if lan_endpoints.private_ip(address):
                    _upsert_peer(properties.get('id'),properties.get('name'),address,info.port,
                                 endpoint_origin=properties.get('origin'),advertised_capabilities=capabilities,
                                 source='mdns',interface=_interface_for(address),ttl=min(120,getattr(info,'host_ttl',120)),
                                 generation=properties.get('discovery_generation'))
        except (ValueError,TypeError,OSError):
            return

    def remove_service(self,zeroconf,service_type,name):
        # Route TTL expires shortly; disappearance never revokes trust or proves offline.
        _notify()


def _close_mdns():
    global _zeroconf,_service,_browser,_mdns_signature
    with _mdns_lock:
        service,zeroconf=_service,_zeroconf
        _zeroconf=_service=_browser=_mdns_signature=None
        if zeroconf:
            try:
                if service:
                    zeroconf.unregister_service(service)
            finally:
                zeroconf.close()


def _refresh_mdns(force=False):
    global _zeroconf,_service,_browser,_mdns_signature
    try:
        from zeroconf import Zeroconf,ServiceInfo,ServiceBrowser,IPVersion
    except ImportError:
        with _state_lock:
            _status['mdns']='dependency_missing'
        return False
    try:
        from tls_cert import stable_lan_origins
        interfaces=sorted({ip for ip,_ in _adapter_networks()})
        addresses=[ip for ip in _listener_addresses() if ip in interfaces]
        origins=stable_lan_origins(S.server_port()); cfg=S.load_node_config()
        signature=(tuple(interfaces),tuple(addresses),tuple(origins),S.server_port(),cfg.node_id,cfg.node_name,_advert_generation)
        with _mdns_lock:
            if _stop_event.is_set() or (not force and _mdns_signature==signature):
                return True
            _close_mdns()
            if not addresses:
                with _state_lock:
                    _status['mdns']='no_private_listener'
                return True
            _zeroconf=Zeroconf(interfaces=addresses,ip_version=IPVersion.V4Only)
            _browser=ServiceBrowser(_zeroconf,SERVICE_TYPE,_DiscoveryListener())
            if origins:
                _service=ServiceInfo(SERVICE_TYPE,cfg.node_id+'.'+SERVICE_TYPE,
                    addresses=[socket.inet_aton(ip) for ip in addresses],port=S.server_port(),server=urlsplit(origins[0]).hostname+'.',
                    properties={'id':cfg.node_id,'name':cfg.node_name,'tls':'1','origin':origins[0],'endpoint_protocol':'tli-endpoint-v1',
                                'discovery_generation':_advert_generation})
                _zeroconf.register_service(_service,allow_name_change=False)
            _mdns_signature=signature
        with _state_lock:
            _status['mdns']='ready' if origins else 'browsing_only'
        return True
    except Exception as exc:
        _close_mdns()
        with _state_lock:
            _status['mdns']='unavailable'
        S.log_debug('mesh','WARN','mDNS discovery unavailable; UDP and connection invitations remain available',error=str(exc))
        return True


def _start_mdns():
    """Watch adapter changes and resume gaps; periodically renew multicast sockets."""
    global _listen_thread,_advert_generation
    previous=None; last=time.time(); renewed=time.monotonic()
    while not _stop_event.is_set():
        now=time.time(); adapters=tuple((ip,str(net)) for ip,net in _adapter_networks())
        changed=previous is not None and (adapters!=previous or now-last>15 or now<last)
        force=changed or time.monotonic()-renewed>300
        if changed:
            _advert_generation = secrets.token_hex(12)
            C.network_changed()
            _broadcast_once()
        if force:
            renewed=time.monotonic()
        _refresh_mdns(force=force)
        if _listen_thread is None or not _listen_thread.is_alive():
            _listen_thread=threading.Thread(target=_listen_loop,daemon=True,name='tli-lan-listen')
            _listen_thread.start()
        previous=adapters; last=now
        _stop_event.wait(5)


def _listen_loop():
    sock=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
    try:
        sock.bind(('0.0.0.0',BEACON_PORT)); sock.settimeout(1)
        with _state_lock:
            _status['udp']='ready'
        while not _stop_event.is_set():
            try:
                data,(address,_)=sock.recvfrom(4097)
                _handle_beacon(data,address)
            except socket.timeout:
                continue
    except OSError:
        with _state_lock:
            _status['udp']='unavailable'
    finally:
        sock.close()


def _try_open_firewall():
    """Compatibility hook; firewall changes require the reviewed setup helper."""
    return None


def start():
    global _broadcast_thread,_mdns_thread
    if _mdns_thread and _mdns_thread.is_alive():
        return
    enabled=bool(_listener_addresses())
    with _state_lock:
        _status.update(enabled=enabled,reason=None if enabled else 'no_private_tls_listener')
    if not enabled:
        return
    _stop_event.clear()
    C.start(_presence_broadcast_fn)
    _broadcast_thread=threading.Thread(target=_broadcast_loop,daemon=True,name='tli-lan-broadcast')
    _mdns_thread=threading.Thread(target=_start_mdns,daemon=True,name='tli-lan-watch')
    _broadcast_thread.start(); _mdns_thread.start()


def stop():
    _stop_event.set()
    _close_mdns(); C.stop()
    with _state_lock:
        _status.update(enabled=False,reason='stopped',mdns='stopped',udp='stopped')
    for thread in (_broadcast_thread,_listen_thread,_mdns_thread):
        if thread and thread is not threading.current_thread():
            thread.join(1.5)
