"""Retired generic signing must never expose the node's private-key authority."""
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

import node_identity
import tli_state as S


@pytest.mark.parametrize("pin_enabled", [False, True], ids=["pin-disabled", "pin-enabled"])
@pytest.mark.parametrize("browser_session", [False, True], ids=["anonymous", "browser-session"])
@pytest.mark.parametrize("body", [
    {"json": {"data_hex": "68656c6c6f"}},
    {"json": {"data_hex": "not-hex"}},
    {"json": {}},
    {"content": b"{malformed-json"},
    {},
], ids=["valid-payload", "invalid-hex", "empty-object", "malformed-json", "no-body"])
def test_signing_is_retired_without_parsing_or_private_key_access(
    app, monkeypatch, pin_enabled, browser_session, body,
):
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": pin_enabled})
    monkeypatch.setattr(S, "_active_sessions", {})
    signer = Mock(side_effect=AssertionError("Generic HTTP signing must never run"))
    identity = Mock(side_effect=AssertionError("Retirement must not load the private identity"))
    monkeypatch.setattr(node_identity, "sign", signer)
    monkeypatch.setattr(node_identity, "_ensure", identity)
    headers = {"Content-Type": "application/json"}
    if browser_session:
        token = S.create_session_token("local")
        assert S.validate_session_token(token)
        headers["Cookie"] = "tli_session=" + token

    response = TestClient(app).post("/identity/sign", headers=headers, **body)

    assert response.status_code == 410
    assert "retired" in response.json()["detail"]
    signer.assert_not_called()
    identity.assert_not_called()


@pytest.mark.parametrize("pin_enabled", [False, True], ids=["pin-disabled", "pin-enabled"])
def test_public_identity_still_returns_the_public_card(app, monkeypatch, pin_enabled):
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": pin_enabled})
    card = {"node_id": "fixture-node", "public_key": "ab" * 32, "fingerprint": "fixture"}
    public_identity = Mock(return_value=card)
    signer = Mock(side_effect=AssertionError("Public identity lookup must not sign"))
    monkeypatch.setattr(node_identity, "identity_card", public_identity)
    monkeypatch.setattr(node_identity, "sign", signer)

    response = TestClient(app).get("/identity")

    assert response.status_code == 200
    assert response.json() == card
    public_identity.assert_called_once_with()
    signer.assert_not_called()


@pytest.mark.parametrize("pin_enabled", [False, True], ids=["pin-disabled", "pin-enabled"])
@pytest.mark.parametrize("valid", [False, True], ids=["invalid-signature", "valid-signature"])
def test_public_signature_verification_remains_available(app, monkeypatch, pin_enabled, valid):
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": pin_enabled})
    verify = Mock(return_value=valid)
    signer = Mock(side_effect=AssertionError("Public verification must not sign"))
    monkeypatch.setattr(node_identity, "verify", verify)
    monkeypatch.setattr(node_identity, "sign", signer)
    body = {"data_hex": "68656c6c6f", "signature_hex": "cd" * 64, "public_key_hex": "ab" * 32}

    response = TestClient(app).post("/identity/verify", json=body)

    assert response.status_code == 200
    assert response.json() == {"valid": valid}
    verify.assert_called_once_with(b"hello", body["signature_hex"], body["public_key_hex"])
    signer.assert_not_called()
