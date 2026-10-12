"""Synthetic hosts and sockets only; no household discovery or trust writes."""
import base64
import copy
import hashlib
import json
import socket
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace as NS

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.x509.oid import NameOID
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import connection_identity as identity
import lan_discovery as discovery
import lan_endpoints as endpoints
import node_identity
import peer_pairing as Q
import peer_trust as P
import tli_state as S
import tls_cert
from routers import mesh_routes as mesh
from tests.test_peer_pairing import pair, request
from tests.test_peer_trust import peers, signed


@pytest.fixture
def v2pair(pair, monkeypatch):
    monkeypatch.setattr(tls_cert, 'stable_lan_origins', lambda port: [])
    monkeypatch.setattr(tls_cert, '_local_ipv4_addresses', lambda: ['192.168.2.10'] if S.load_node_config().node_id == 'computer-a' else ['192.168.2.20'])
    return pair


def complete(pair, grants, update=False):
    outgoing = Q.start(pair.b.card['node_id'], None, 'owner', request(), version=2, grants=grants, review_update=update)['request']
    with pair.active('b'):
        incoming = Q.requests('owner', request())['requests'][0]
        assert incoming['code'] == outgoing['code']
        Q.confirm(incoming['request_id'], incoming['code'], True, 'owner', request(), grants=grants)
    Q.confirm(outgoing['request_id'], outgoing['code'], True, 'owner', request(), grants=grants)
    return Q.refresh(outgoing['request_id'], 'owner', request())['request']


def test_v2_bilateral_permissions_and_reviewed_update_preserve_old_until_confirmation(v2pair):
    pair = v2pair
    assert complete(pair, ['messages'])['state'] == 'connected'
    pair.a.requests.clear(); pair.b.requests.clear()
    with pytest.raises(HTTPException):
        Q.start(pair.b.card['node_id'], None, 'owner', request())
    original = pair.a.directory_path.read_bytes()
    outgoing = Q.start(pair.b.card['node_id'], None, 'owner', request(), version=2,
                       grants=['inference', 'messages', 'observe'], review_update=True)['request']
    assert pair.a.directory_path.read_bytes() == original
    assert outgoing['review_update'] and outgoing['grants'] == ['inference', 'messages', 'observe']
    with pytest.raises(HTTPException):
        Q.confirm(outgoing['request_id'], outgoing['code'], True, 'owner', request(), grants=['messages'])
    assert pair.a.directory_path.read_bytes() == original
    Q.confirm(outgoing['request_id'], outgoing['code'], True, 'owner', request(), grants=outgoing['grants'])
    assert P.trusted(pair.b.card['node_id'])[0]['peer_trust']['grants'] == outgoing['grants']
    with pair.active('b'):
        incoming = Q.requests('owner', request())['requests'][0]
        assert P.trusted(pair.a.card['node_id'])[0]['peer_trust']['grants'] == ['messages']
        Q.confirm(incoming['request_id'], incoming['code'], True, 'owner', request(), grants=incoming['grants'])
    assert Q.refresh(outgoing['request_id'], 'owner', request())['request']['state'] == 'connected'


def test_v2_transcript_binds_permissions_and_interfaces(v2pair):
    pair = v2pair
    view = Q.start(pair.b.card['node_id'], None, 'owner', request(), version=2, grants=['inference'])['request']
    assert view['grants'] == ['inference']
    init = pair.a.requests[view['request_id']]['init']
    nonce = 'a' * 64
    expected = Q._commit(init, nonce)
    for key, value in [('grants', ['messages']), ('source_endpoint', '192.168.2.99'), ('target_endpoint', '192.168.2.98'), ('review_update', True)]:
        assert Q._commit({**init, key: value}, nonce) != expected
    with pair.active('b'):
        with pytest.raises(HTTPException):
            Q._peer_source(request('192.168.2.99', token=None, hostname='192.168.2.20'), pair.a.card, init['source_endpoint'])


def test_v2_empty_permissions_never_silently_grants_messages(v2pair):
    with pytest.raises(HTTPException) as error:
        Q.start(v2pair.b.card['node_id'], None, 'owner', request(), version=2, grants=[])
    assert error.value.detail['code'] == 'pairing_grants'
    assert not v2pair.a.requests and not v2pair.b.requests


def test_compute_only_cards_require_v2_inference_pairing(v2pair):
    card = copy.deepcopy(v2pair.b.card)
    card['capabilities'] = ['inference_v1']
    card.pop('signature')
    card['signature'] = v2pair.b.key.sign(P.canonical(card)).hex()
    with pytest.raises(HTTPException) as error:
        Q._card(card)
    assert error.value.detail['code'] == 'pairing_inference_only'
    assert Q._card(card, Q.PROTOCOL_V2, ['inference']) == card
    with pytest.raises(HTTPException):
        Q._card(card, Q.PROTOCOL_V2, ['inference', 'messages'])


def test_message_grant_can_check_signed_status_without_system_permission(peers):
    directory = S.load_mesh_directory()
    directory['peer-b']['peer_trust']['grants'] = ['messages']
    S.save_mesh_directory(directory)
    app = FastAPI(); app.include_router(mesh.router)
    raw, headers = signed(peers, '/agent/peer/status', {'challenge': 'ab' * 24})
    with TestClient(app, base_url=peers.a['origin']) as client:
        result = client.post('/agent/peer/status', content=raw, headers=headers)
        assert result.status_code == 200, result.text
        assert result.json()['grants'] == ['messages']
        assert 'cpu_percent' not in result.json()
        assert client.post('/agent/peer/status', content=raw, headers=headers).status_code == 409
    assert not P.capability('peer-b')['available']


@pytest.mark.parametrize('grants', [['messages'], ['coordinate', 'messages']])
def test_older_reviewed_hosts_keep_operations_without_inventing_status(peers, monkeypatch, grants):
    from routers import system_routes
    directory = S.load_mesh_directory()
    directory['peer-b']['peer_trust']['grants'] = grants
    S.save_mesh_directory(directory)
    calls = []
    monkeypatch.setattr(P, 'request', lambda *args, **kwargs: P.Response(404, b'{}'))
    monkeypatch.setattr(P, 'health', lambda device: calls.append(device) or {'online': True, 'node_id': device})
    monkeypatch.setattr(system_routes, 'agent_health', lambda: {'node_name': 'Local'})
    monkeypatch.setattr(mesh, '_ensure_host_in_mesh_directory', lambda: None)
    before = S.MESH_DIRECTORY_PATH.read_bytes()
    import peer_connections as C
    assert mesh.mesh_health(_session='owner')['nodes'][1]['connection_state'] in {'unknown','discovered'}
    assert not calls
    C.check('peer-b')
    result = next(row for row in mesh.mesh_health(_session='owner')['nodes'] if row.get('peer_id') == 'peer-b')
    assert result['connection_state'] == ('connected' if 'coordinate' in grants else 'review_required')
    assert result['online'] is (True if 'coordinate' in grants else None)
    assert calls == (['peer-b'] if 'coordinate' in grants else [])
    assert P.message_readiness('peer-b')['available']
    assert S.MESH_DIRECTORY_PATH.read_bytes() == before


def test_arrival_cursor_does_not_skip_same_time_or_delayed_messages(tmp_path, monkeypatch):
    monkeypatch.setattr(mesh, 'MESH_CHAT_DIR', tmp_path)
    monkeypatch.setattr(S, 'encrypt_jsonl_line', json.dumps)
    monkeypatch.setattr(S, 'decrypt_jsonl_line', json.loads)
    for identifier, stamp in [('one', 9000), ('two', 9000)]:
        mesh._append_chat_msg('thread', {'message_id': identifier, 'ts': stamp})
    page = mesh.mesh_chat_messages('thread', since=999999, cursor=0)
    assert [m['message_id'] for m in page['messages']] == ['one', 'two']
    mesh._append_chat_msg('thread', {'message_id': 'late', 'ts': 1000})
    next_page = mesh.mesh_chat_messages('thread', since=999999, cursor=page['next_cursor'])
    assert [m['message_id'] for m in next_page['messages']] == ['late']
    assert next_page['next_cursor'] == 3
    assert mesh.mesh_chat_messages('thread', since=0, cursor=3)['messages'] == []


def stable_card(peers, dns_name='workshop.local'):
    now = datetime.now(timezone.utc)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Synthetic LAN')])
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(peers.key_b.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(days=1)).not_valid_after(now+timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName(dns_name)]), critical=False).sign(peers.key_b, None))
    der = cert.public_bytes(serialization.Encoding.DER)
    card = {**peers.b, 'protocol': P.PROTOCOL_V2, 'origin': 'https://workshop.local:8443',
            'certificate_der': base64.b64encode(der).decode(), 'certificate_sha256': hashlib.sha256(der).hexdigest()}
    card.pop('signature'); card['signature'] = peers.key_b.sign(P.canonical(card)).hex()
    return card


def test_stable_card_requires_exact_san_and_v2_protocol(peers):
    card = stable_card(peers)
    assert P.validate_card(card) == card
    assert P.validate_card(stable_card(peers, 'WORKSHOP.LOCAL'))['origin'] == card['origin']
    for changes in ({'protocol': P.PROTOCOL}, {'origin': 'https://another.local:8443'}):
        other = {**card, **changes}; other.pop('signature'); other['signature'] = peers.key_b.sign(P.canonical(other)).hex()
        with pytest.raises(HTTPException):
            P.validate_card(other)


def test_dns_routes_are_private_bounded_and_never_change_trust(peers, monkeypatch):
    before = S.MESH_DIRECTORY_PATH.read_bytes()
    monkeypatch.setattr(socket, 'getaddrinfo', lambda *args: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', (ip, 8443)) for ip in ['8.8.8.8', '127.0.0.1', '192.168.2.50']])
    endpoints.remember('workshop.local', ['192.168.2.60', '1.2.3.4'])
    assert endpoints.resolve('workshop.local', 8443) == ['192.168.2.60', '192.168.2.50']
    assert S.MESH_DIRECTORY_PATH.read_bytes() == before
    with pytest.raises(ValueError):
        endpoints.resolve('example.com', 443)


@pytest.mark.parametrize('change', ['none', 'nonce', 'key', 'origin', 'expired', 'closed'])
def test_endpoint_proof_precedes_sensitive_request_and_checks_identity(peers, change):
    card = stable_card(peers)
    requests = []
    class Connection:
        sock = None if change == 'closed' else object()
        def request(self, method, path, body, headers):
            requests.append((method, path, json.loads(body), headers))
        def getresponse(self):
            nonce = requests[-1][2]['nonce']; now = int(time.time())
            value = {'protocol': 'tli-endpoint-v1', 'node_id': card['node_id'], 'public_key': card['public_key'],
                     'origin': card['origin'], 'certificate_sha256': card['certificate_sha256'], 'nonce': nonce,
                     'issued_at': now, 'expires_at': now+30}
            if change == 'nonce': value['nonce'] = '0'*48
            if change == 'key': value['public_key'] = peers.a['public_key']
            if change == 'origin': value['origin'] = 'https://other.local:8443'
            if change == 'expired': value.update(issued_at=now-60, expires_at=now-30)
            value['signature'] = peers.key_b.sign(P.canonical(value)).hex()
            return NS(status=200, read=lambda bound: P.canonical(value))
    if change == 'none':
        P._prove_endpoint(Connection(), card)
    else:
        with pytest.raises(HTTPException): P._prove_endpoint(Connection(), card)
    assert len(requests) == 1 and requests[0][1] == '/api/connection/v1/identity'
    assert set(requests[0][3]) == {'Content-Type', 'Accept'}


def test_mdns_observation_retains_saved_authority(peers, monkeypatch):
    original = S.load_mesh_directory()['peer-b']
    monkeypatch.setattr(discovery, '_presence_broadcast_fn', None)
    discovery._upsert_peer('peer-b', 'Unsigned name', '192.168.2.77', 8443, endpoint_origin='https://workshop.local:8443')
    observed = S.load_mesh_directory()['peer-b']
    hint = observed.pop('discovery')
    assert observed == original
    assert hint['origin'] == 'https://workshop.local:8443' and hint['verified'] is False


def test_identity_challenge_uses_only_existing_identity(peers, monkeypatch):
    monkeypatch.setattr(S, 'TLS_ENABLED', True)
    monkeypatch.setattr(tls_cert, 'stable_lan_origins', lambda port: ['https://home.local:8443'])
    monkeypatch.setattr(tls_cert, '_local_ipv4_addresses', lambda: [])
    monkeypatch.setattr(tls_cert, 'certificate_bundle', lambda *args: {'fingerprint': peers.a['certificate_sha256']})
    monkeypatch.setattr(node_identity, 'read_existing', lambda root: {'public_key_hex': peers.a['public_key'], 'private_key': peers.key_a})
    proof = identity.identity_proof(identity.Challenge(nonce='aa'*24, origin='https://home.local:8443', node_id=peers.a['node_id']))
    signature = proof.pop('signature')
    assert node_identity.verify(P.canonical(proof), signature, peers.a['public_key'])
    assert proof['expires_at'] - proof['issued_at'] == 30
    with pytest.raises(HTTPException):
        identity.identity_proof(identity.Challenge(nonce='aa'*24, origin='https://attacker.local:8443', node_id=peers.a['node_id']))


def test_stable_advertisement_requires_existing_cert_and_actual_listener(monkeypatch):
    monkeypatch.setattr(S, 'TLS_ENABLED', True)
    monkeypatch.setattr(tls_cert, '_local_ipv4_addresses', lambda: ['127.0.0.1', '192.168.2.10', '10.4.2.3'])
    monkeypatch.setattr(tls_cert.socket, 'gethostname', lambda: 'Workshop')
    calls = []
    monkeypatch.setattr(tls_cert, 'certificate_bundle', lambda cert, key, name: calls.append(name))
    monkeypatch.setattr(S, 'SERVER_BIND_HOST', '127.0.0.1', raising=False)
    assert tls_cert.stable_lan_origins(8443) == [] and not calls
    monkeypatch.setattr(S, 'SERVER_BIND_HOST', '192.168.2.10')
    assert tls_cert.lan_listener_addresses() == ['192.168.2.10']
    assert tls_cert.stable_lan_origins(443) == ['https://workshop.local:443']
    assert calls == ['workshop.local']
    def missing(*args): raise ValueError('SAN not covered')
    monkeypatch.setattr(tls_cert, 'certificate_bundle', missing)
    assert tls_cert.stable_lan_origins(8443) == []


def test_private_route_socket_keeps_reviewed_hostname_for_tls(monkeypatch):
    calls = []
    raw = NS(settimeout=lambda timeout: calls.append(('timeout', timeout)), close=lambda: calls.append(('close',)))
    secured = object()
    conn = endpoints.LANHTTPSConnection('workshop.local', 8443, timeout=2)
    conn._context = NS(wrap_socket=lambda value, server_hostname: calls.append(('tls', value, server_hostname)) or secured)
    monkeypatch.setattr(endpoints, 'resolve', lambda *args: ['192.168.2.77'])
    monkeypatch.setattr(endpoints.socket, 'create_connection', lambda target, timeout, source: calls.append(('connect', target)) or raw)
    conn.connect()
    assert conn.sock is secured
    assert calls[0] == ('connect', ('192.168.2.77', 8443))
    assert calls[-1] == ('tls', raw, 'workshop.local')


def test_mdns_rebinds_changed_adapter_without_touching_saved_trust(peers, monkeypatch):
    import sys
    import threading
    import ipaddress
    original = S.MESH_DIRECTORY_PATH.read_bytes()
    calls = []
    address = ['192.168.2.10']
    class FakeZeroconf:
        def __init__(self, **kwargs): calls.append(('open', kwargs['interfaces']))
        def register_service(self, info, **kwargs): calls.append(('register', info))
        def unregister_service(self, info): calls.append(('unregister', info))
        def close(self): calls.append(('close',))
    monkeypatch.setitem(sys.modules, 'zeroconf', NS(Zeroconf=FakeZeroconf, ServiceInfo=lambda *args, **kwargs: kwargs,
                         ServiceBrowser=lambda *args: object(), IPVersion=NS(V4Only=4)))
    monkeypatch.setattr(S, 'TLS_ENABLED', True)
    monkeypatch.setattr(discovery, '_stop_event', threading.Event())
    for field in ('_zeroconf', '_service', '_browser', '_mdns_signature'):
        monkeypatch.setattr(discovery, field, None)
    monkeypatch.setattr(discovery, '_adapter_networks', lambda: [(address[0], ipaddress.IPv4Network('192.168.2.0/24'))])
    monkeypatch.setattr(tls_cert, 'lan_listener_addresses', lambda: list(address))
    monkeypatch.setattr(tls_cert, 'stable_lan_origins', lambda port: [f'https://home.local:{port}'])
    monkeypatch.setattr(S, 'server_port', lambda: 9443)
    assert discovery._refresh_mdns()
    assert discovery._refresh_mdns()
    assert len([call for call in calls if call[0] == 'open']) == 1
    address[0] = '192.168.2.77'
    discovery._refresh_mdns()
    advertisements = [call[1] for call in calls if call[0] == 'register']
    assert len(advertisements) == 2 and advertisements[-1]['addresses'] == [socket.inet_aton(address[0])]
    assert advertisements[-1]['properties']['origin'] == 'https://home.local:9443'
    assert advertisements[-1]['properties']['discovery_generation'] == discovery._advert_generation
    assert advertisements[-1]['port'] == 9443 and ('close',) in calls
    discovery._close_mdns()
    assert S.MESH_DIRECTORY_PATH.read_bytes() == original


def test_node_dns_sd_advertises_inference_only_and_rebinds_without_trust(peers, monkeypatch):
    import sys
    import node_discovery
    calls = []
    addresses = ['192.168.2.20']
    class FakeZeroconf:
        def __init__(self, **kwargs): calls.append(('open', kwargs))
        def register_service(self, info, **kwargs): calls.append(('register', info))
        def unregister_service(self, info): calls.append(('unregister', info))
        def close(self): calls.append(('close',))
    monkeypatch.setitem(sys.modules, 'zeroconf', NS(Zeroconf=FakeZeroconf, ServiceInfo=lambda *args, **kwargs: kwargs, IPVersion=NS(V4Only=4)))
    monkeypatch.setattr(node_discovery, 'private_adapters', lambda: list(addresses))
    monkeypatch.setattr(tls_cert, 'stable_lan_origins', lambda port: [f'https://workshop.local:{port}'])
    marker = {'origin':'https://workshop.local:9444', 'node_id':'synthetic-node', 'name':'Compute only'}
    advertiser = node_discovery.Advertiser(marker)
    before = S.MESH_DIRECTORY_PATH.read_bytes()
    advertiser.refresh()
    addresses[0] = '192.168.2.77'
    advertiser.refresh()
    services = [value for kind, *tail in calls if kind == 'register' for value in tail]
    assert len(services) == 2 and services[-1]['addresses'] == [socket.inet_aton(addresses[0])]
    assert services[-1]['port'] == 9444 and services[-1]['properties']['origin'] == marker['origin']
    assert json.loads(services[-1]['properties']['capabilities']) == ['inference_v1']
    assert services[-1]['properties']['discovery_generation'] == advertiser.generation
    advertiser.stop()
    assert S.MESH_DIRECTORY_PATH.read_bytes() == before
    discovery._upsert_peer('unreviewed-node', 'Compute only', addresses[0], 9444, endpoint_origin=marker['origin'], advertised_capabilities=['inference_v1'])
    assert P.public_trust('unreviewed-node')['peer_profile'] == 'inference_node'
    with pytest.raises(HTTPException): P.trusted('unreviewed-node', 'inference')
