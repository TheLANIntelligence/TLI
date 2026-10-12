"""Trust setup reads isolated listener/identity facts without granting trust."""
import base64
import copy
import ipaddress
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.x509.oid import NameOID
from fastapi import FastAPI
from fastapi.testclient import TestClient

import node_identity
import peer_trust as P
import tli_state as S
import tls_cert
from routers import mesh_routes


@pytest.fixture
def setup_host(tmp_path, monkeypatch):
    addresses = ["192.168.50.12"]
    key = Ed25519PrivateKey.generate()
    public = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    (tmp_path / "node_identity.json").write_text(json.dumps({
        "version": 1, "node_id": "tli_" + public.hex()[:12], "public_key": public.hex(),
        "private_key_enc": base64.b64encode(key.private_bytes(serialization.Encoding.Raw,
            serialization.PrivateFormat.Raw, serialization.NoEncryption())).decode(),
        "dpapi": False, "created_at": "synthetic",
    }), encoding="utf-8")
    cfg_path = tmp_path / "node_config.json"
    cfg_path.write_text(json.dumps({"node_id": "synthetic-host", "node_name": "Friendly computer",
        "role": "standalone", "mesh_status": "unpaired", "created_at": "synthetic", "updated_at": "synthetic"}), encoding="utf-8")
    now = datetime.now(timezone.utc)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Synthetic trust setup")])
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.IPv4Address(value))
            for value in ["192.168.50.12", "10.8.0.2", "172.30.128.1", "169.254.8.2", "8.8.8.8"]]), critical=False)
        .sign(key, None))
    cert_path, key_path = tmp_path / "cert.pem", tmp_path / "key.pem"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "NODE_CONFIG_PATH", cfg_path)
    monkeypatch.setattr(S, "MESH_DIRECTORY_PATH", tmp_path / "directory.json")
    monkeypatch.setattr(S, "SERVER_BIND_HOST", "0.0.0.0", raising=False)
    monkeypatch.setattr(S, "SERVER_BIND_PORT", 8443)
    monkeypatch.setattr(S, "TLS_ENABLED", True)
    monkeypatch.setattr(S, "TLS_CERT_PATH", str(cert_path))
    monkeypatch.setattr(S, "TLS_KEY_PATH", str(key_path))
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    monkeypatch.setattr(S, "validate_session_token", lambda token: token == "browser-token")
    monkeypatch.setattr(S, "get_session_user_id", lambda token: "owner")
    monkeypatch.setattr(tls_cert, "_local_ipv4_addresses", lambda: addresses)
    prohibited = Mock(side_effect=AssertionError("Setup attempted a mutation or peer probe"))
    for module, name in [(tls_cert, "ensure_tls_cert"), (S, "load_node_config"),
                         (S._security, "write_json"), (node_identity, "_ensure"),
                         (P, "approve"), (P, "preview"), (P, "_exchange")]:
        monkeypatch.setattr(module, name, prohibited)
    app = FastAPI()
    app.include_router(mesh_routes.router)
    with TestClient(app, base_url="https://localhost:8443") as client:
        yield SimpleNamespace(client=client, addresses=addresses, prohibited=prohibited,
                              root=tmp_path, cert_path=cert_path, key_path=key_path, cfg_path=cfg_path)


def read(host, **headers):
    response = host.client.get("/mesh/trust/setup", headers={"Cookie": "tli_session=browser-token", **headers})
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    return response.json()


def test_setup_requires_session(setup_host):
    assert setup_host.client.get("/mesh/trust/setup").status_code == 401
    setup_host.prohibited.assert_not_called()


def test_setup_automatically_returns_valid_public_card_without_writes(setup_host):
    before = {p.name: p.read_bytes() for p in setup_host.root.iterdir()}
    previews = copy.deepcopy(P._PREVIEWS)
    data = read(setup_host)
    assert data["ready"] is True and data["code"] == "ready" and data["reason"] is None
    assert data["node"] == {"id": "synthetic-host", "name": "Friendly computer"}
    assert data["origins"] == ["https://192.168.50.12:8443"]
    assert data["selected_origin"] == data["card"]["origin"] == data["origins"][0]
    assert P.validate_card(data["card"]) == data["card"]
    assert not any("private" in name for name in data["card"])
    assert before == {p.name: p.read_bytes() for p in setup_host.root.iterdir()}
    assert P._PREVIEWS == previews
    setup_host.prohibited.assert_not_called()


@pytest.mark.parametrize("setting,value,code", [
    ("TLS_ENABLED", False, "https_required"),
    ("SERVER_BIND_HOST", "127.0.0.1", "lan_required"),
    ("SERVER_BIND_HOST", "localhost", "lan_required"),
    ("SERVER_BIND_HOST", "::", "lan_required"),
    ("SERVER_BIND_HOST", None, "lan_required"),
])
def test_running_listener_gates_setup(setup_host, monkeypatch, setting, value, code):
    monkeypatch.setattr(S, setting, value)
    data = read(setup_host, Host="192.168.50.12:8443")
    assert data["code"] == code and not data["ready"] and data["card"] is None
    assert not data["origins"] and data["selected_origin"] is None
    assert "Secure home-network access" in data["reason"]


def test_multiple_addresses_require_choice_unless_browser_uses_valid_candidate(setup_host):
    setup_host.addresses[:] = ["192.168.50.12", "10.8.0.2", "172.30.128.1"]
    data = read(setup_host)
    assert data["code"] == "choose_address" and not data["ready"] and data["card"] is None
    assert data["selected_origin"] is None and len(data["origins"]) == 3
    data = read(setup_host, Host="192.168.50.12:8443")
    assert data["ready"] and data["selected_origin"] == "https://192.168.50.12:8443"
    assert data["card"]["origin"] == data["selected_origin"]


def test_host_and_forwarded_headers_do_not_add_origins_or_supply_listener_port(setup_host):
    setup_host.addresses.append("10.8.0.2")
    data = read(setup_host, Host="192.168.80.99:9999", **{"X-Forwarded-Host": "192.168.50.12:9999"})
    assert data["code"] == "choose_address" and data["selected_origin"] is None
    assert data["origins"] == ["https://10.8.0.2:8443", "https://192.168.50.12:8443"]
    data = read(setup_host, Host="192.168.50.12:9999")
    assert data["selected_origin"] == "https://192.168.50.12:8443"


def test_candidates_must_be_local_private_and_covered_by_certificate(setup_host):
    setup_host.addresses[:] = ["192.168.50.12", "192.168.50.13", "169.254.8.2", "100.64.0.2",
                               "8.8.8.8", "127.0.0.1", "::1", "example.test", "192.168.50.12"]
    data = read(setup_host)
    assert data["origins"] == ["https://192.168.50.12:8443"] and data["ready"]
    setup_host.addresses[:] = ["169.254.8.2", "8.8.8.8"]
    data = read(setup_host, Host="192.168.50.12:8443")
    assert data["code"] == "address_unavailable" and data["card"] is None


def test_explicit_bind_intersects_detected_addresses(setup_host, monkeypatch):
    setup_host.addresses.append("10.8.0.2")
    monkeypatch.setattr(S, "SERVER_BIND_HOST", "192.168.50.12")
    assert read(setup_host)["origins"] == ["https://192.168.50.12:8443"]
    setup_host.addresses[:] = ["10.8.0.2"]
    assert read(setup_host)["code"] == "address_unavailable"


@pytest.mark.parametrize("failure", ["missing", "invalid", "uncovered"])
def test_certificate_failures_explain_empty_card_without_repair(setup_host, failure):
    if failure == "missing":
        setup_host.key_path.unlink()
    elif failure == "invalid":
        setup_host.cert_path.write_bytes(b"invalid synthetic certificate")
    else:
        setup_host.addresses[:] = ["192.168.50.13"]
    before = {p.name: p.read_bytes() for p in setup_host.root.iterdir()}
    data = read(setup_host)
    assert data["code"] == "certificate_unavailable" and not data["ready"]
    assert data["card"] is None and not data["origins"] and "certificate" in data["reason"]
    assert before == {p.name: p.read_bytes() for p in setup_host.root.iterdir()}
    setup_host.prohibited.assert_not_called()


@pytest.mark.parametrize("filename", ["node_identity.json", "node_config.json"])
def test_missing_identity_is_never_initialized_by_setup(setup_host, filename):
    (setup_host.root / filename).unlink()
    before = {p.name: p.read_bytes() for p in setup_host.root.iterdir()}
    data = read(setup_host)
    assert data["code"] == "identity_unavailable" and data["card"] is None and not data["ready"]
    assert before == {p.name: p.read_bytes() for p in setup_host.root.iterdir()}
    setup_host.prohibited.assert_not_called()


def test_https_default_port_is_explicit_in_canonical_card(setup_host, monkeypatch):
    monkeypatch.setattr(S, "SERVER_BIND_PORT", 443)
    data = read(setup_host)
    assert data["ready"] and data["selected_origin"] == "https://192.168.50.12:443"
    assert P.validate_card(data["card"])["origin"] == data["selected_origin"]
