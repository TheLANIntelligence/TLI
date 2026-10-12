"""Public invitation imports never approve peers or perform network I/O."""
import base64
import copy
import json

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import connection_invitation as I
import lan_endpoints
import node_identity
import peer_pairing as Q
import peer_trust as P
import tli_state as S
from routers.peer_pairing_routes import router
from tests.test_peer_trust import peers, entry
from tests.test_connected_mesh_v2 import stable_card


def invitation(peers, monkeypatch, card=None, addresses=None):
    card = card or peers.b
    with monkeypatch.context() as mp:
        mp.setattr(node_identity, 'sign', lambda raw: peers.key_b.sign(raw).hex())
        return I.encode(card, addresses or ['192.168.2.20'])


def rewrite(text, change):
    body = text[len(I.PREFIX):]
    value = json.loads(base64.urlsafe_b64decode(body + '=' * (-len(body) % 4)))
    change(value)
    return I.PREFIX + base64.urlsafe_b64encode(P.canonical(value)).decode().rstrip('=')


def test_import_preserves_trust_and_blocked_state(peers, monkeypatch):
    text = invitation(peers, monkeypatch)
    before = copy.deepcopy(S.load_mesh_directory()['peer-b'])
    result = I.import_invitation(text)
    after = S.load_mesh_directory()['peer-b']
    assert not result['trust_granted'] and result['review_update']
    assert after['peer_trust'] == before['peer_trust']
    assert after['status'] == before['status']
    directory = S.load_mesh_directory()
    directory['peer-b']['status'] = 'blocked'
    S.save_mesh_directory(directory)
    I.import_invitation(text)
    assert S.load_mesh_directory()['peer-b']['status'] == 'blocked'


def test_new_invitation_is_pending_only(peers, monkeypatch):
    S.save_mesh_directory({})
    result = I.import_invitation(invitation(peers, monkeypatch))
    assert result['device_id'] == 'peer-b'
    assert result['peer_profile'] == 'full_host'
    assert not result['review_update']
    saved = S.load_mesh_directory()['peer-b']
    assert saved['status'] == 'pending' and 'peer_trust' not in saved


def test_stable_invitation_retains_every_address(peers, monkeypatch):
    card = stable_card(peers)
    monkeypatch.setattr(lan_endpoints, '_HINTS', {})
    monkeypatch.setattr(lan_endpoints, '_dns', lambda *args: [])
    text = invitation(peers, monkeypatch, card, ['192.168.2.20', '10.5.2.20'])
    I.import_invitation(text)
    assert set(lan_endpoints.resolve('workshop.local', 8443)) == {'192.168.2.20', '10.5.2.20'}
    assert S.load_mesh_directory()['peer-b']['discovery']['origin'] == card['origin']


@pytest.mark.parametrize('change', [
    lambda v: v.update(addresses=['8.8.8.8']),
    lambda v: v.update(addresses=['192.168.2.21']),
    lambda v: v['card'].update(name='Impostor'),
    lambda v: v.update(signature='0'*128),
    lambda v: v.update(credential='no-secret-allowed'),
])
def test_tampered_or_unsafe_invitation_changes_nothing(peers, monkeypatch, change):
    before = S.MESH_DIRECTORY_PATH.read_bytes()
    text = rewrite(invitation(peers, monkeypatch), change)
    with pytest.raises(HTTPException):
        I.import_invitation(text)
    assert S.MESH_DIRECTORY_PATH.read_bytes() == before


@pytest.mark.parametrize('text', ['{}', 'TLI-CONNECT-1.!!!', 'x'*60001, I.PREFIX+'a'], ids=['json','characters','oversized','truncated'])
def test_invalid_invitation_is_bounded(text):
    with pytest.raises(HTTPException): I.decode(text)


def test_invitation_http_owner_boundary(peers, monkeypatch):
    app = FastAPI(); app.include_router(router)
    text = invitation(peers, monkeypatch)
    with TestClient(app, base_url='https://localhost') as client:
        for headers in ({}, {'Authorization':'Bearer dummy'}, {'X-TLI-Peer-ID':'peer-b'}, {'Cookie':'tli_session=browser-token', 'Origin':'https://other.local'}):
            response = client.post('/mesh/pairing/invitation/import', json={'invitation':text}, headers=headers)
            assert response.status_code in (401,403)
        response = client.post('/mesh/pairing/invitation/import', json={'invitation':text}, headers={'Cookie':'tli_session=browser-token','Origin':'https://localhost'})
        assert response.status_code == 200 and response.json()['trust_granted'] is False


def test_pairing_selects_live_alternative_before_commit(monkeypatch):
    monkeypatch.setattr(lan_endpoints, 'resolve', lambda *args: ['192.168.2.20','10.5.2.20'])
    monkeypatch.setattr(Q, '_source_endpoint', lambda origin, target: '10.5.2.10' if target.startswith('10.') else '192.168.2.10')
    calls=[]
    class Socket:
        def __enter__(self): return self
        def __exit__(self,*args): pass
        def close(self): pass
    def connect(address, timeout, source):
        calls.append((address,timeout,source))
        if address[0].startswith('192.'): raise OSError('dead route')
        return Socket()
    monkeypatch.setattr(Q.socket, 'create_connection', connect)
    class Context:
        def wrap_socket(self, raw, **kw): return raw
    monkeypatch.setattr(Q.ssl, 'SSLContext', lambda *args: Context())
    assert Q._select_route('https://workshop.local:8443', 'https://home.local:8443') == ('10.5.2.20','10.5.2.10')
    assert len(calls) == 2 and calls[1][0][1] == 8443


def test_node_invitation_cli_exports_public_compute_card_without_host_imports(tmp_path):
    from tests.test_node_cli import invoke, fingerprints
    root = tmp_path / 'node'
    initialized = invoke('init', '--state-dir', root, '--name', 'Compute', '--origin', 'https://192.168.50.9:8444')
    assert initialized.returncode == 0, initialized.stderr
    before = fingerprints(root)
    exported = invoke('invitation', '--state-dir', root, patch="import atexit; atexit.register(lambda: (_ for _ in ()).throw(AssertionError('host imported')) if {'main','lan_discovery','routers.system_routes'} & set(sys.modules) else None)")
    assert exported.returncode == 0, exported.stderr
    assert 'host imported' not in exported.stderr
    card, addresses = I.decode(exported.stdout.strip())
    assert card['capabilities'] == ['inference_v1'] and addresses == ['192.168.50.9']
    assert fingerprints(root) == before
