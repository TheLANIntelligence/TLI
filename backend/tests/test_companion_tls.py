from datetime import datetime, timedelta, timezone
import base64
import ipaddress

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

import tls_cert


@pytest.fixture(autouse=True)
def isolated_server_bind(monkeypatch):
    import tli_state as S
    monkeypatch.setattr(S, "SERVER_BIND_HOST", None, raising=False)
    monkeypatch.setattr(S, "SERVER_BIND_PORT", None, raising=False)
    monkeypatch.setattr(S, "TLS_ENABLED", False)


def write_certificate(tmp_path, *, expired=False, future=False, mismatched=False):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "TLI test")])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now + timedelta(days=1) if future else now - timedelta(days=2))
            .not_valid_after(now - timedelta(days=1) if expired else now + timedelta(days=2))
            .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("192.168.1.12"))]), critical=False)
            .sign(key, hashes.SHA256()))
    cert_path, key_path = tmp_path / "cert.pem", tmp_path / "key.pem"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    if mismatched:
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    return str(cert_path), str(key_path)


def test_qr_public_certificate_matches_configured_server(tmp_path):
    cert_path, key_path = write_certificate(tmp_path)
    result = tls_cert.certificate_bundle(cert_path, key_path, "192.168.1.12")
    cert = x509.load_der_x509_certificate(base64.b64decode(result["certificate_der"]))
    assert result["fingerprint"] == cert.fingerprint(hashes.SHA256()).hex()
    assert set(result) == {"certificate_der", "fingerprint"}


@pytest.mark.parametrize("options", [{"expired": True}, {"future": True}, {"mismatched": True}])
def test_existing_invalid_identity_is_rejected_and_never_replaced(tmp_path, options):
    cert_path, key_path = write_certificate(tmp_path, **options)
    before = (tmp_path / "cert.pem").read_bytes(), (tmp_path / "key.pem").read_bytes()
    assert not tls_cert.ensure_tls_cert(cert_path, key_path)
    with pytest.raises(ValueError):
        tls_cert.certificate_bundle(cert_path, key_path, "192.168.1.12")
    assert before == ((tmp_path / "cert.pem").read_bytes(), (tmp_path / "key.pem").read_bytes())


def test_changed_lan_address_requires_certificate_repair(tmp_path):
    cert_path, key_path = write_certificate(tmp_path)
    with pytest.raises(ValueError, match="not covered"):
        tls_cert.certificate_bundle(cert_path, key_path, "192.168.1.13")


def test_partial_certificate_pair_is_not_silently_regenerated(tmp_path):
    cert_path, key_path = write_certificate(tmp_path)
    (tmp_path / "key.pem").unlink()
    before = (tmp_path / "cert.pem").read_bytes()
    assert not tls_cert.ensure_tls_cert(cert_path, key_path)
    assert (tmp_path / "cert.pem").read_bytes() == before
    assert not (tmp_path / "key.pem").exists()


def test_generation_includes_lan_addresses(tmp_path, monkeypatch):
    monkeypatch.setattr(tls_cert, "_local_ipv4_addresses", lambda: ["192.168.1.12"])
    cert_path, key_path = str(tmp_path / "new.pem"), str(tmp_path / "new.key")
    assert tls_cert.ensure_tls_cert(cert_path, key_path)
    assert tls_cert.certificate_bundle(cert_path, key_path, "192.168.1.12")["certificate_der"]


def test_requested_https_failure_does_not_start_http(monkeypatch):
    import main
    import uvicorn
    import launch_checks
    monkeypatch.setenv("TLI_ENABLE_TLS", "1")
    monkeypatch.setattr(launch_checks, "check_port", lambda *args: None)
    monkeypatch.setattr(tls_cert, "ensure_tls_cert", lambda *args: False)
    monkeypatch.setattr(uvicorn, "run", lambda *a, **kw: pytest.fail("HTTP fallback was started"))
    with pytest.raises(RuntimeError, match="HTTP was not started"):
        main._tli_run_server()


def test_explicit_false_tls_setting_keeps_existing_http_behavior(monkeypatch):
    import main
    import uvicorn
    import launch_checks
    calls = []
    monkeypatch.setenv("TLI_ENABLE_TLS", "0")
    monkeypatch.setattr(launch_checks, "check_port", lambda *args: None)
    monkeypatch.setattr(uvicorn, "run", lambda *a, **kw: calls.append(kw))
    monkeypatch.setattr(tls_cert, "ensure_tls_cert", lambda *a: pytest.fail("TLS enabled unexpectedly"))
    main._tli_run_server()
    assert calls[0]["ssl_certfile"] is None
    assert calls[0]["timeout_graceful_shutdown"] == 30
