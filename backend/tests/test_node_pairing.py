"""Synthetic full host/Node, local console authority, and bounded public routes."""
import time

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import node_pairing
import peer_pairing as Q
import peer_trust as P
import tli_state as S
import tls_cert
from peer_pairing_public import make_public_router
from tests.test_peer_pairing import pair, request


@pytest.fixture
def nodepair(pair, monkeypatch):
    pair.b.card['capabilities'] = ['inference_v1']
    pair.b.card.pop('signature')
    pair.b.card['signature'] = pair.b.key.sign(P.canonical(pair.b.card)).hex()
    monkeypatch.setattr(S, 'SERVER_BIND_PORT', 8443)
    monkeypatch.setattr(tls_cert, 'stable_lan_origins', lambda port: [])
    monkeypatch.setattr(tls_cert, '_local_ipv4_addresses', lambda: ['192.168.2.10', '192.168.2.20'])
    monkeypatch.setattr(tls_cert, 'lan_listener_addresses', lambda: ['192.168.2.20'])
    pair.b.node_window = node_pairing.PairingWindow(pair.b.card)
    with pair.active('b'):
        pair.b.node_window.start(console=False)
    return pair


def begin(pair, **kwargs):
    return Q.start(pair.b.card['node_id'], None, 'owner', request(), version=2, grants=['inference'], **kwargs)['request']


def test_host_node_automatic_public_exchange_needs_both_local_confirmations(nodepair):
    pair = nodepair
    before = pair.a.directory_path.read_bytes(), pair.b.directory_path.read_bytes()
    outgoing = begin(pair)
    assert outgoing['peer']['profile'] == 'inference_node'
    assert outgoing['grants'] == ['inference']
    assert before == (pair.a.directory_path.read_bytes(), pair.b.directory_path.read_bytes())
    with pair.active('b'):
        window = pair.b.node_window
        incoming = window.views()[0]
        assert incoming['peer']['profile'] == 'full_host' and incoming['code'] == outgoing['code']
        response_card = pair.b.requests[incoming['request_id']]['response']['card']
        assert response_card['capabilities'] == ['inference_v1']
        with pytest.raises(HTTPException):
            Q.confirm(incoming['request_id'], incoming['code'], True, 'owner', request(), grants=['inference'])
        assert pair.b.directory_path.read_bytes() == before[1]
        window.confirm(incoming['request_id'], incoming['code'])
        assert P.trusted(pair.a.card['node_id'], 'inference')[0]['peer_trust']['grants'] == ['inference']
        assert window.accepting is False
    assert pair.a.directory_path.read_bytes() == before[0]
    Q.confirm(outgoing['request_id'], outgoing['code'], True, 'owner', request(), grants=['inference'])
    assert Q.refresh(outgoing['request_id'], 'owner', request())['request']['state'] == 'connected'
    with pair.active('b'):
        assert window.views()[0]['state'] == 'connected'
        # A lost acknowledgment can be checked again within the same window.
    pair.a.requests[outgoing['request_id']]['last_poll'] = -100
    assert Q.refresh(outgoing['request_id'], 'owner', request())['request']['state'] == 'connected'


@pytest.mark.parametrize('change', ['expiry', 'stopped', 'wrong_object', 'wrong_code', 'blocked', 'renamed', 'key', 'grant', 'cancelled'])
def test_node_confirmation_rechecks_window_identity_transcript_and_trust(nodepair, change):
    pair = nodepair
    view = begin(pair)
    with pair.active('b'):
        window = pair.b.node_window
        code = view['code']
        if change == 'expiry': window.expires = time.monotonic() - 1
        elif change == 'stopped': window.stop()
        elif change == 'wrong_object': window = node_pairing.PairingWindow(pair.b.card)
        elif change == 'wrong_code': code = '0000-0000-0000'
        elif change in ('blocked', 'renamed'):
            directory = S.load_mesh_directory()
            directory[pair.a.card['node_id']]['status' if change == 'blocked' else 'display_name'] = 'blocked' if change == 'blocked' else 'Changed'
            S.save_mesh_directory(directory)
        elif change == 'key': pair.b.card['public_key'] = '0'*64
        elif change == 'grant': pair.b.requests[view['request_id']]['init']['grants'] = ['inference', 'messages']
        elif change == 'cancelled': window.decline(view['request_id'])
        before = pair.b.directory_path.read_bytes()
        with pytest.raises(HTTPException): window.confirm(view['request_id'], code)
        assert pair.b.directory_path.read_bytes() == before


@pytest.mark.parametrize('version,grants', [(1,['messages']), (2,['messages']), (2,['inference','messages']), (2,['observe'])])
def test_node_public_receive_rejects_other_protocols_and_permissions(nodepair, version, grants):
    before = nodepair.b.directory_path.read_bytes()
    with pytest.raises(HTTPException):
        Q.start(nodepair.b.card['node_id'], None, 'owner', request(), version=version, grants=grants)
    assert nodepair.b.directory_path.read_bytes() == before
    assert not nodepair.b.requests


def test_node_rejects_node_to_node_pairing(nodepair):
    pair = nodepair
    pair.a.card['capabilities'] = ['inference_v1']
    pair.a.card.pop('signature')
    pair.a.card['signature'] = pair.a.key.sign(P.canonical(pair.a.card)).hex()
    with pytest.raises(HTTPException) as error: begin(pair)
    assert error.value.detail['code'] == 'pairing_host_required'
    assert not pair.b.requests


def test_node_replacement_requires_local_option_and_fresh_code(nodepair):
    pair = nodepair
    with pytest.raises(HTTPException) as error: begin(pair, review_update=True)
    assert error.value.detail['code'] == 'pairing_local_review_required'
    pair.a.requests.clear()
    pair.b.node_window.review_update = True
    with pair.active('b'):
        directory = S.load_mesh_directory()
        directory[pair.a.card['node_id']]['status'] = 'blocked'
        S.save_mesh_directory(directory)
    before = pair.b.directory_path.read_bytes()
    view = begin(pair, review_update=True)
    assert pair.b.directory_path.read_bytes() == before
    with pair.active('b'):
        pair.b.node_window.confirm(view['request_id'], view['code'])
        assert P.trusted(pair.a.card['node_id'], 'inference')


def test_closed_node_policy_cannot_fall_back_to_full_host_pairing(nodepair):
    pair = nodepair
    with pair.active('b'):
        window = pair.b.node_window
        window.stop()
        assert Q._NODE_PAIRING is window
        with pytest.raises(HTTPException): Q.browser_owner(request())
        app = FastAPI(); app.include_router(make_public_router(node_window=window))
        with TestClient(app) as client:
            for path in Q._PATHS:
                response = client.post(path, json={})
                assert response.status_code == 404 and response.json()['detail']['code'] == 'pairing_window_closed'


def test_node_public_http_has_no_remote_approval_and_rejects_credentials(nodepair):
    pair = nodepair
    view = begin(pair)
    init = pair.calls[0][2]
    with pair.active('b'):
        window = pair.b.node_window
        # Discard the pending synthetic request to test a new receive at the HTTP boundary.
        pair.b.requests.clear()
        app = FastAPI(); app.include_router(make_public_router(node_window=window))
        assert set(app.openapi()['paths']) == Q._PATHS
        with TestClient(app, base_url=pair.b.card['origin'], client=('192.168.2.10',4321)) as client:
            for headers in ({'Authorization':'Bearer fake'}, {'Cookie':'tli_session=fake'}, {'X-TLI-Peer-Node':'fake'}):
                assert client.post('/agent/pairing/request',json=init,headers=headers).status_code == 403
            for path in ('/mesh/pairing/requests', '/mesh/pairing/'+view['request_id']+'/confirm', '/agent/pairing/confirm'):
                assert client.post(path,json={'code':view['code']}).status_code == 404
            assert client.post('/agent/pairing/request',json=init).status_code == 200


def test_expiry_while_console_input_is_pending_and_terminal_text_is_escaped(nodepair):
    pair = nodepair
    pair.a.card['name'] = 'Host\nCODE: 0000-0000-0000\x1b[2J'
    pair.a.card.pop('signature')
    pair.a.card['signature'] = pair.a.key.sign(P.canonical(pair.a.card)).hex()
    view = begin(pair)
    with pair.active('b'):
        window = pair.b.node_window
        output = []
        window.write_line = output.append
        def expired_input(prompt):
            window.expires = time.monotonic() - 1
            return view['code']
        window.read_line = expired_input
        before = pair.b.directory_path.read_bytes()
        window._console()
        assert pair.b.directory_path.read_bytes() == before
        assert any('\\nCODE:' in line and '\\u001b[2J' in line for line in output)
        assert not any('\x1b' in line for line in output)
        assert Q._NODE_PAIRING is window and window.closed


def test_expiry_during_card_review_is_rechecked_before_commit(nodepair, monkeypatch):
    view = begin(nodepair)
    with nodepair.active('b'):
        window = nodepair.b.node_window
        original = P.preview
        def expire(*args, **kwargs):
            result = original(*args, **kwargs)
            window.expires = time.monotonic() - 1
            return result
        monkeypatch.setattr(P, 'preview', expire)
        before = nodepair.b.directory_path.read_bytes()
        with pytest.raises(HTTPException): window.confirm(view['request_id'], view['code'])
        assert nodepair.b.directory_path.read_bytes() == before


def test_node_confirmation_serializes_with_separate_local_admin_writer(nodepair):
    from tli_node import _lock, _root
    view = begin(nodepair)
    with nodepair.active('b'), _lock(_root(S.BASE_DIR), '.node-admin.lock'):
        before = nodepair.b.directory_path.read_bytes()
        with pytest.raises(HTTPException) as error:
            nodepair.b.node_window.confirm(view['request_id'], view['code'])
        assert error.value.detail['code'] == 'pairing_local_busy'
        assert nodepair.b.directory_path.read_bytes() == before
