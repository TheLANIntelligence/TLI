"""Manual trust cannot bypass the connection request's browser authority boundary."""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import tli_state as S
from routers import mesh_routes as mesh
from tests.test_peer_trust import peers


@pytest.mark.parametrize('route,body', [
    ('/mesh/trust/preview', {'card': {}, 'grants': ['messages']}),
    ('/mesh/trust/approve', {'review_id': 'absent', 'identity_fingerprint': 'x', 'certificate_sha256': 'x'}),
    ('/mesh/trust/peer-b/revoke', {}),
])
@pytest.mark.parametrize('case', ['anonymous_lan', 'cross_origin', 'bearer', 'rebound_host'])
def test_trust_mutations_require_local_browser_authority(peers, monkeypatch, route, body, case):
    monkeypatch.setattr(S, 'load_pin_config', lambda: {'enabled': False})
    app = FastAPI(); app.include_router(mesh.router)
    source = '192.168.2.50' if case == 'anonymous_lan' else '127.0.0.1'
    hostname = 'attacker.example' if case == 'rebound_host' else 'localhost'
    headers = {'Origin': 'https://attacker.example'} if case == 'cross_origin' else {}
    if case == 'bearer': headers['Authorization'] = 'Bearer peer-or-companion-token'
    before = S.MESH_DIRECTORY_PATH.read_bytes()
    with TestClient(app, base_url='https://' + hostname, client=(source, 12345)) as client:
        if case == 'cross_origin': client.cookies.set('tli_session', 'browser-token')
        result = client.post(route, json=body, headers=headers)
    assert result.status_code in (401, 403), result.text
    assert S.MESH_DIRECTORY_PATH.read_bytes() == before


def test_authenticated_browser_can_still_review_and_revoke(peers):
    app = FastAPI(); app.include_router(mesh.router)
    with TestClient(app, base_url='https://localhost', client=('127.0.0.1', 12345)) as client:
        client.cookies.set('tli_session', 'browser-token')
        review = client.post('/mesh/trust/preview', json={'card': peers.b, 'grants': ['messages']})
        assert review.status_code == 200, review.text
        approved = client.post('/mesh/trust/approve', json={
            'review_id': review.json()['review_id'],
            'identity_fingerprint': peers.b['identity_fingerprint'],
            'certificate_sha256': peers.b['certificate_sha256'],
        })
        assert approved.status_code == 200, approved.text
        assert S.load_mesh_directory()['peer-b']['peer_trust']['grants'] == ['messages']
        assert client.post('/mesh/trust/peer-b/revoke').status_code == 200
        assert S.load_mesh_directory()['peer-b']['status'] == 'blocked'
