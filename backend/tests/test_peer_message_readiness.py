"""Messaging setup diagnostics never replace reviewed peer authorization."""
import pytest
from fastapi import HTTPException

import peer_trust as P
import tli_state as S
from tests.test_peer_trust import entry, peers


@pytest.mark.parametrize("status,code,wording", [
    ("pending", "peer_pending", "review needed"),
    ("blocked", "peer_blocked", "Blocked"),
])
def test_message_readiness_distinguishes_local_pending_and_blocked(peers, status, code, wording):
    S.save_mesh_directory({"peer-b": entry(peers.b, status=status)})
    before = S.MESH_DIRECTORY_PATH.read_bytes()
    result = P.message_readiness("peer-b")
    assert result["available"] is False and result["code"] == code
    assert wording in result["message"]
    assert "Computers" in result["message"] and "Text messages" in result["message"]
    with pytest.raises(HTTPException) as exc:
        P.request("peer-b", "POST", "/mesh/chat/receive", grant="messages")
    assert exc.value.detail["code"] == "peer_not_allowed"
    assert status in exc.value.detail["message"].lower()
    assert "pending or blocked" not in exc.value.detail["message"]
    assert S.MESH_DIRECTORY_PATH.read_bytes() == before


@pytest.mark.parametrize("change", ["missing", "signature", "address", "fingerprint", "malformed_grants"])
def test_message_readiness_requires_current_verified_identity_and_certificate(peers, change):
    saved = entry(peers.b)
    if change == "missing":
        saved.pop("peer_trust")
    elif change == "signature":
        saved["peer_trust"]["card"]["signature"] = "0" * 128
    elif change == "address":
        saved["ip"] = "192.168.2.21"
    elif change == "fingerprint":
        saved["identity_fingerprint"] = "changed"
    else:
        saved["peer_trust"]["grants"] = ["messages", "messages"]
    S.save_mesh_directory({"peer-b": saved})
    before = S.MESH_DIRECTORY_PATH.read_bytes()
    result = P.message_readiness("peer-b")
    assert result["available"] is False and result["code"] == "review_required"
    with pytest.raises(HTTPException) as exc:
        P.request("peer-b", "POST", "/mesh/chat/receive", grant="messages")
    assert exc.value.detail["code"] == "review_required"
    assert S.MESH_DIRECTORY_PATH.read_bytes() == before


def test_message_readiness_needs_separate_messages_grant(peers):
    S.save_mesh_directory({"peer-b": entry(peers.b, grants=["observe", "coordinate"])})
    before = S.MESH_DIRECTORY_PATH.read_bytes()
    result = P.message_readiness("peer-b")
    assert result["available"] is False and result["code"] == "messages_permission_required"
    with pytest.raises(HTTPException) as exc:
        P.request("peer-b", "POST", "/mesh/chat/receive", grant="messages")
    assert exc.value.detail["code"] == "capability_required"
    assert S.MESH_DIRECTORY_PATH.read_bytes() == before


def test_message_readiness_is_explicitly_local_and_never_probes_or_grants(peers):
    before = S.MESH_DIRECTORY_PATH.read_bytes()
    result = P.message_readiness("peer-b")
    assert result["available"] is True and result["code"] == "reviewed_locally"
    assert "other computer must also review" in result["message"]
    assert S.MESH_DIRECTORY_PATH.read_bytes() == before
    assert P.message_readiness("missing")["code"] == "peer_missing"


@pytest.mark.parametrize("status,code", [
    (403, "peer_not_allowed"), (404, "peer_missing"),
    (409, "review_required"), (403, "capability_required"),
])
def test_recognized_remote_message_trust_rejection_identifies_other_computer(peers, monkeypatch, status, code):
    calls = []
    def exchange(*args):
        calls.append(args)
        return P.Response(status, P.canonical({"detail": {"code": code, "message": "Untrusted remote wording"}}))
    monkeypatch.setattr(P, "_exchange", exchange)
    before = S.MESH_DIRECTORY_PATH.read_bytes()
    with pytest.raises(HTTPException) as exc:
        P.request("peer-b", "POST", "/mesh/chat/receive", json_body={"body": "hello"}, grant="messages")
    assert exc.value.status_code == 409
    assert exc.value.detail["code"] == "peer_message_review_required"
    assert "on the other computer" in exc.value.detail["message"]
    assert "Text messages" in exc.value.detail["message"]
    assert "Untrusted remote wording" not in exc.value.detail["message"]
    assert len(calls) == 1 and S.MESH_DIRECTORY_PATH.read_bytes() == before


@pytest.mark.parametrize("status,body", [
    (403, b'not json'), (409, b'[]'), (409, b'{"detail": "rejected"}'),
    (409, b'{"detail": {"code": "message_uncertain"}}'),
    (409, b'{"detail": {"code": "capability_required", "message": "Peer file transfer requires a separate reviewed capability."}}'),
    (502, b'{"detail": {"code": "review_required"}}'),
])
def test_other_remote_message_errors_keep_delivery_uncertain(peers, monkeypatch, status, body):
    response = P.Response(status, body)
    monkeypatch.setattr(P, "_exchange", lambda *args: response)
    assert P.request("peer-b", "POST", "/mesh/chat/receive", grant="messages") is response


def test_message_diagnostics_do_not_change_other_peer_operations(peers, monkeypatch):
    response = P.Response(403, P.canonical({"detail": {"code": "capability_required"}}))
    monkeypatch.setattr(P, "_exchange", lambda *args: response)
    assert P.request("peer-b", "GET", "/agent/peer/health") is response
