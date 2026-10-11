"""Remote guidance reads real routing/auth code with isolated local facts only."""
import json
from pathlib import Path
from unittest.mock import Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import companion_auth as auth
import tli_state as S
import tls_cert
from routers import companion_routes as routes


@pytest.fixture
def remote_host(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "SERVER_BIND_HOST", "0.0.0.0", raising=False)
    monkeypatch.setattr(S, "SERVER_BIND_PORT", 8443, raising=False)
    monkeypatch.setattr(S, "TLS_ENABLED", True)
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    monkeypatch.setattr(S, "validate_session_token", lambda token: token == "test-owner-session")
    monkeypatch.setattr(S, "get_session_user_id", lambda token: "test-owner")
    monkeypatch.setattr(routes, "_node", lambda: {"id": "test-host", "name": "Test host"})
    addresses = ["192.168.50.12", "10.8.0.2", "172.30.128.1", "169.254.8.2", "100.64.0.2", "8.8.8.8", "127.0.0.1"]
    monkeypatch.setattr(tls_cert, "_local_ipv4_addresses", lambda: addresses)
    monkeypatch.setattr(tls_cert, "certificate_bundle", lambda *a: {"certificate_der": "synthetic-public-cert", "fingerprint": "f" * 64})
    prohibited = Mock(side_effect=AssertionError("Readiness attempted a mutation"))
    monkeypatch.setattr(tls_cert, "ensure_tls_cert", prohibited)
    monkeypatch.setattr(auth, "create_pairing", prohibited)
    monkeypatch.setattr(auth, "_write", prohibited)
    for name in ["certificate.pem", "private.key", "credentials.json"]:
        (tmp_path/name).write_bytes(b"preserve-existing-synthetic-identity")
    app = FastAPI(); app.include_router(routes.router)
    with TestClient(app, base_url="https://192.168.50.12:8443") as client:
        yield client, addresses, prohibited, tmp_path


def read(client):
    response = client.get("/api/companion/v1/setup", headers={"Cookie": "tli_session=test-owner-session"})
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    return response.json()


def test_remote_readiness_is_authenticated_and_not_a_vpn_check(remote_host):
    client, addresses, prohibited, root = remote_host
    assert client.get("/api/companion/v1/setup").status_code == 401
    before = {p.name:p.read_bytes() for p in root.iterdir()}
    for _ in range(3):
        data = read(client); remote = data["remote_access"]
        assert remote["host_ready"] is True
        assert remote["route_status"] == "not_tested" and remote["tunnel_status"] == "unknown"
        assert remote["eligible_origins"] == ["https://10.8.0.2:8443", "https://172.30.128.1:8443", "https://192.168.50.12:8443"]
        assert "https://169.254.8.2:8443" in data["origins"]
        assert not any("100.64" in value or "8.8.8.8" in value for value in data["origins"])
        assert remote["checked_at"].endswith("+00:00")
    assert before == {p.name:p.read_bytes() for p in root.iterdir()}
    prohibited.assert_not_called()


@pytest.mark.parametrize("field,value", [("TLS_ENABLED", False), ("SERVER_BIND_HOST", "127.0.0.1")])
def test_missing_secure_host_setup_never_claims_ready(remote_host, monkeypatch, field, value):
    monkeypatch.setattr(S, field, value)
    remote = read(remote_host[0])["remote_access"]
    assert remote["host_ready"] is False and remote["route_status"] == "not_tested"


def test_no_pin_or_missing_certificate_never_claims_ready(remote_host, monkeypatch):
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": False})
    assert read(remote_host[0])["remote_access"]["host_ready"] is False
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    def missing(*args): raise ValueError("Existing certificate does not cover this address.")
    monkeypatch.setattr(tls_cert, "certificate_bundle", missing)
    remote = read(remote_host[0])["remote_access"]
    assert not remote["eligible_origins"] and not remote["host_ready"]
    assert "certificate" in remote["reason"]


def test_link_local_and_missing_adapters_keep_lan_contract_but_not_remote_readiness(remote_host):
    client, addresses, _, _ = remote_host
    addresses[:] = ["169.254.8.2"]
    data = read(client)
    assert data["pairing_ready"] is True
    assert data["remote_access"]["host_ready"] is False
    assert "Link-local" in data["remote_access"]["reason"]
    addresses.clear()
    assert read(client)["remote_access"]["eligible_origins"] == []


def test_explicit_binding_and_untrusted_host_header_cannot_add_routes(remote_host, monkeypatch):
    monkeypatch.setattr(S, "SERVER_BIND_HOST", "192.168.50.12")
    client = remote_host[0]
    response = client.get("/api/companion/v1/setup", headers={"Cookie":"tli_session=test-owner-session", "Host":"8.8.8.8:9999"})
    assert response.json()["remote_access"]["eligible_origins"] == ["https://192.168.50.12:8443"]


@pytest.mark.parametrize("origin", ["https://100.64.0.2:8443", "https://8.8.8.8:8443", "https://host.example:8443"])
def test_remote_guidance_does_not_expand_pairing_authority(remote_host, origin):
    response = remote_host[0].post("/api/companion/v1/pairings", json={"origin":origin}, headers={"Cookie":"tli_session=test-owner-session"})
    assert response.status_code == 422
    remote_host[2].assert_not_called()
