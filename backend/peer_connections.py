"""One cached projection of discovery, reviewed authority and verified reachability.

Discovery cannot create grants. Background work checks reviewed identities only,
is coalesced per identity/revision and never runs inference or replays user work.
Lists read this cache without waiting for network I/O.
"""
from __future__ import annotations

import copy
import threading
import time
from datetime import datetime, timezone

from fastapi import HTTPException

import lan_endpoints
import peer_trust as P
import tli_state as S

LOCK = threading.RLock()
_ROUTES = {}
_CHECKS = {}
_HINT_CHECKS = {}
_INFLIGHT = {}
_SLOTS = threading.BoundedSemaphore(4)
_STOP = threading.Event()
_THREAD = None
_EMIT = None
_GENERATION = 0
_NETWORK_CHANGED_AT = 0
FRESH_SECONDS = 90
PROTOCOL = 'tli-connections-v1'
SCHEMA_VERSION = 1


def _iso(epoch=None):
    return datetime.fromtimestamp(time.time() if epoch is None else epoch, timezone.utc).isoformat()


def _stamp(value):
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except (AttributeError, ValueError, TypeError):
        return 0


def _emit(peer_id=None):
    callback = _EMIT
    if callback:
        try:
            event = {'type':'connection_changed', 'node_id':peer_id} if peer_id else {'type':'directory_changed'}
            callback({**event,'protocol':PROTOCOL,'schema_version':SCHEMA_VERSION})
        except Exception:
            pass


def observe(peer_id, address, port, *, origin=None, source='legacy', interface=None, ttl=120, generation=None):
    address = lan_endpoints.private_ip(address)
    if not address or not isinstance(peer_id, str) or not 1 <= len(peer_id) <= 128 or type(port) is not int or not 1 <= port <= 65535:
        return
    now = time.monotonic()
    source, interface = str(source)[:64], str(interface or '')[:64]
    generation = generation if isinstance(generation,str) and len(generation)==24 and all(c in '0123456789abcdef' for c in generation) else None
    expedite = False
    if origin:
        try:
            from urllib.parse import urlsplit
            origin = lan_endpoints.canonical_origin(origin)
            parsed = urlsplit(origin)
            if parsed.port != port:
                origin = None
            elif lan_endpoints.stable_name(parsed.hostname):
                lan_endpoints.remember(parsed.hostname, [address], source=source, interface=interface, ttl=ttl)
        except ValueError:
            origin = None
    with LOCK:
        for key in list(_ROUTES):
            _ROUTES[key] = {route:value for route,value in _ROUTES[key].items() if value['expires'] > now}
            if not _ROUTES[key]:
                del _ROUTES[key]
        if peer_id not in _ROUTES and len(_ROUTES) >= 512:
            return
        rows = _ROUTES.setdefault(peer_id, {})
        key = (address, port, source, interface)
        previous = rows.get(key)
        last_observed = max((row.get('observed',now) for row in rows.values()),default=0)
        returned = not previous or (generation and previous.get('generation') != generation) or now-last_observed >= 45
        rows[key] = {'address':address, 'port':port, 'origin':origin,
            'source':source, 'interface':interface or None, 'generation':generation, 'observed':now,
            'observed_at':_iso(), 'expires':now+min(300,max(5,ttl))}
        while len(rows) > 16:
            del rows[min(rows,key=lambda key:rows[key]['expires'])]
        cached = _CHECKS.get(peer_id)
        # A changed process/resume generation, new route or legacy quiet gap is
        # only a reason to recheck saved authority. Repeated beacons do not
        # reset failure backoff; hostile hints cannot exceed one wake/10s.
        # Invitation import stays entirely offline, and permission/identity
        # failures still require explicit review instead of hint-driven retries.
        if (source in {'udp','mdns'} and returned and cached and cached['value']['state']=='unreachable'
                and now-_HINT_CHECKS.get(peer_id,float('-inf')) >= 10):
            _HINT_CHECKS[peer_id] = now
            while len(_HINT_CHECKS) > 512:
                del _HINT_CHECKS[next(iter(_HINT_CHECKS))]
            cached['next'] = min(cached['next'],max(now,cached.get('last_attempt',0)+2))
            expedite = True
    _emit(peer_id)
    if expedite:
        try:
            schedule(peer_id)
        except HTTPException:
            pass  # Revoked/changed authority cannot be restored by discovery.


def discovery(peer_id, entry=None, *, check=None):
    with P.observation_access(check):
        return _discovery(peer_id, entry, check=check)


def _discovery(peer_id, entry=None, *, check=None):
    with LOCK:
        S._security._read_access(check)
        rows = [copy.deepcopy(row) for row in _ROUTES.get(peer_id,{}).values() if row['expires'] > time.monotonic()]
    S._security._read_access(check)
    observed = max((row['observed_at'] for row in rows), default=None)
    if observed is None and entry:
        observed = (entry.get('discovery') or {}).get('observed_at')
    recent = bool(rows) or bool(observed and _stamp(observed) >= _NETWORK_CHANGED_AT and 0 <= time.time()-_stamp(observed) < 90)
    return {'seen_recently':recent, 'last_observed_at':observed, 'sources':sorted({row['source'] for row in rows}),
            'candidate_count':len({(row['address'],row['port']) for row in rows}),
            'candidates':[{key:value for key,value in row.items() if key not in {'expires','observed'}} for row in rows]}


def _capabilities(grants, ready=(), *, connected=False, node=False, models=None):
    result = {}
    for grant in sorted(P.GRANTS):
        state = 'permission_required' if grant not in grants else 'not_checked'
        if connected:
            state = 'ready' if grant in ready else 'permission_required'
        if grant == 'inference' and grant in ready:
            state = 'ready' if node and models else 'no_model' if node else 'not_checked'
        result[grant] = {'state':state}
        if grant == 'inference' and models is not None:
            result[grant]['models'] = models
    return result


def snapshot(peer_id, entry=None, *, check=None):
    with P.observation_access(check):
        return _snapshot(peer_id, entry, check=check)


def _snapshot(peer_id, entry=None, *, check=None):
    if entry is None:
        directory = S.load_mesh_directory(check=check) if check is not None else S.load_mesh_directory()
        entry = directory.get(peer_id, {})
    found = discovery(peer_id, entry, check=check) if check is not None else discovery(peer_id, entry)
    try:
        current, card, revision = P.trusted(peer_id, check=check) if check is not None else P.trusted(peer_id)
        # Grants must come from the same validated snapshot as this revision.
        # A caller's older directory entry remains discovery evidence only.
        if check is not None:
            entry = current
        grants = entry.get('peer_trust',{}).get('grants',[])
    except HTTPException as error:
        P.observation_error(error, check)
        value = {'protocol':PROTOCOL,'schema_version':SCHEMA_VERSION,'state':'review_required', 'online':None, 'checked_at':None, 'expires_at':None,
                'reason':error.detail, 'capabilities':_capabilities([]), 'retry_after_seconds':0,
                'discovery':found, 'ready_grants':[], 'fresh':False}
        if check is not None:
            value['trust_revision'] = None
        return value
    with LOCK:
        S._security._read_access(check)
        cached = copy.deepcopy(_CHECKS.get(peer_id))
        flight = _INFLIGHT.get(peer_id)
    S._security._read_access(check)
    state = 'discovered' if found['seen_recently'] else 'unknown'
    value = {'protocol':PROTOCOL,'schema_version':SCHEMA_VERSION,'state':state, 'online':None, 'checked_at':None, 'expires_at':None, 'reason':None,
             'capabilities':_capabilities(grants), 'ready_grants':[], 'fresh':False}
    if cached and cached['revision'] == revision:
        value.update(cached['value'])
        value['fresh'] = cached['expires'] > time.monotonic()
        if not value['fresh']:
            value.update(state=state, online=None, ready_grants=[], capabilities=_capabilities(grants))
        value['retry_after_seconds'] = max(0, int(cached['next']-time.monotonic()+.999))
    else:
        value['retry_after_seconds'] = 0
    if flight and flight['revision'] == revision:
        value.update(state='checking', online=None)
    value['discovery'] = found
    if check is not None:
        value['trust_revision'] = revision
    return value


def _failure(error):
    reason = error.detail if isinstance(error, HTTPException) and isinstance(error.detail,dict) else {'code':'peer_unavailable','message':'This computer could not be reached. Check its connection and try again.'}
    identity = reason.get('code') in {'peer_certificate_changed','peer_identity_changed','invalid_card','peer_changed'}
    review = reason.get('code') in {'peer_not_allowed','peer_untrusted','peer_review_required','peer_forbidden','peer_status_unsupported','review_required','peer_missing','capability_required','peer_message_review_required'} or (isinstance(error,HTTPException) and error.status_code == 403)
    return ('identity_changed' if identity else 'review_required' if review else 'unreachable'), reason


def _perform(peer_id, card, revision, event, generation):
    grants = []
    failures, delay = 1, 5
    value = {'state':'unknown','online':None,'reason':{'code':'check_interrupted','message':'Connection check was interrupted.'},
             'checked_at':None,'expires_at':None,'ready_grants':[],'capabilities':_capabilities([])}
    try:
        entry, _, current_revision = P.trusted(peer_id)
        if current_revision != revision:
            raise HTTPException(409, {'code':'peer_changed','message':'Reviewed trust changed before this connection check.'})
        grants = entry['peer_trust']['grants']
        node = card['capabilities'] == P.INFERENCE_CAPABILITIES
        if node:
            import lan_inference
            catalog = lan_inference.models(peer_id)
            result = {'online':True, 'node_id':peer_id, 'node_name':card['name'], 'ready_grants':['inference'],
                      'local_grants':['inference'], 'remote_grants':['inference'], 'models':len(catalog['resources'])}
        else:
            try:
                result = P.check_status(peer_id)
            except HTTPException as error:
                # v1 compatibility uses only an already reviewed grant. It
                # does not imply bilateral messages or inference readiness.
                grants = P.trusted(peer_id)[0]['peer_trust']['grants']
                if not isinstance(error.detail,dict) or error.detail.get('code') != 'peer_status_unsupported' or 'coordinate' not in grants:
                    raise
                result = {**P.health(peer_id), 'ready_grants':['coordinate'], 'legacy_status':True}
        if P.trusted(peer_id)[2] != revision:
            raise HTTPException(409, {'code':'peer_changed','message':'Reviewed trust changed during this connection check.'})
        grants = P.trusted(peer_id)[0]['peer_trust']['grants']
        value = {**result, 'state':'connected', 'reason':None, 'checked_at':_iso(), 'expires_at':_iso(time.time()+FRESH_SECONDS),
                 'capabilities':_capabilities(grants,result['ready_grants'],connected=True,node=node,models=result.get('models'))}
        failures, delay = 0, 45
    except Exception as error:
        state, reason = _failure(error)
        with LOCK:
            old = _CHECKS.get(peer_id,{})
            failures = old.get('failures',0)+1 if old.get('revision') == revision else 1
            since = old.get('value',{}).get('unreachable_since') if old.get('revision') == revision else None
        delay = min(120,5*2**min(failures-1,5))
        value = {'state':state,'online':False if state == 'unreachable' else None,'reason':reason,'checked_at':_iso(),
                 'expires_at':_iso(time.time()+delay),'ready_grants':[], 'capabilities':_capabilities(grants),
                 'unreachable_since':(since or _iso()) if state == 'unreachable' else None}
    finally:
        with LOCK:
            if generation == _GENERATION:
                _CHECKS[peer_id] = {'revision':revision,'value':value,'expires':time.monotonic()+(FRESH_SECONDS if not failures else delay),
                                    'next':time.monotonic()+delay,'failures':failures,'last_attempt':time.monotonic()}
                while len(_CHECKS) > 512:
                    del _CHECKS[next(iter(_CHECKS))]
            if _INFLIGHT.get(peer_id,{}).get('event') is event:
                _INFLIGHT.pop(peer_id,None)
        event.set(); _SLOTS.release(); _emit(peer_id)


def schedule(peer_id, *, force=False):
    _, card, revision = P.trusted(peer_id)
    with LOCK:
        flight = _INFLIGHT.get(peer_id)
        if flight:
            return flight['event']
        cached = _CHECKS.get(peer_id)
        if cached and cached['revision'] == revision:
            limit = cached.get('last_attempt',0)+2 if force else cached['next']
            if time.monotonic() < limit:
                return None
        if not _SLOTS.acquire(blocking=False):
            return None
        event = threading.Event()
        _INFLIGHT[peer_id] = {'event':event,'revision':revision}
        generation = _GENERATION
        try:
            threading.Thread(target=_perform,args=(peer_id,card,revision,event,generation),daemon=True,name='tli-peer-check').start()
        except Exception:
            _INFLIGHT.pop(peer_id,None)
            _SLOTS.release()
            event.set()
            raise
    _emit(peer_id)
    return event


def check(peer_id):
    event = schedule(peer_id, force=True)
    if event:
        event.wait(14)
    value = snapshot(peer_id)
    return {'protocol':PROTOCOL,'schema_version':SCHEMA_VERSION,'node_id':peer_id, 'online':value['online'], 'ready_grants':value.get('ready_grants',[]),
            'checked_at':value['checked_at'], 'connection':value, 'ok':value['state']=='connected'}


def network_changed():
    global _GENERATION, _NETWORK_CHANGED_AT
    lan_endpoints.invalidate()
    with LOCK:
        _GENERATION += 1
        _NETWORK_CHANGED_AT = time.time()
        _CHECKS.clear(); _ROUTES.clear(); _HINT_CHECKS.clear()
    _emit()


def _loop():
    while not _STOP.wait(3):
        try:
            directory = S.load_mesh_directory()
            for peer_id, entry in directory.items():
                if _STOP.is_set():
                    break
                if not entry.get('peer_trust') or entry.get('status') != 'allowed':
                    continue
                try:
                    schedule(peer_id)
                except HTTPException:
                    continue
        except Exception:
            pass


def start(emit=None):
    global _THREAD, _EMIT
    _EMIT = emit
    if _THREAD and _THREAD.is_alive():
        return
    _STOP.clear()
    _THREAD = threading.Thread(target=_loop,daemon=True,name='tli-peer-connections')
    _THREAD.start()


def stop():
    global _EMIT
    _STOP.set(); _EMIT = None
    network_changed()
    if _THREAD and _THREAD is not threading.current_thread():
        _THREAD.join(1)
