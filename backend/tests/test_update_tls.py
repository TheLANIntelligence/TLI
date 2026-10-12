"""Exercise the actual update HTTPS transport against owned loopback servers."""
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import socket
import ssl
import threading
from urllib.error import URLError
import urllib.request

import certifi
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
import pytest

import auto_update as U


def _authority(folder, name):
    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=30)).not_valid_after(now + timedelta(days=30))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False,
                                        key_encipherment=False, data_encipherment=False, key_agreement=False,
                                        key_cert_sign=True, crl_sign=True, encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
            .sign(key, hashes.SHA256()))
    path = folder / (name + ".pem")
    path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return key, cert, path


def _leaf(folder, authority, number, *, wrong_hostname=False, expired=False):
    ca_key, ca_cert, _ = authority
    key = ec.generate_private_key(ec.SECP256R1())
    now = datetime.now(timezone.utc)
    names = [x509.DNSName("wrong.example.invalid")] if wrong_hostname else [
        x509.IPAddress(ipaddress.ip_address("127.0.0.1")), x509.DNSName("localhost")]
    cert = (x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Loopback update fixture")]))
            .issuer_name(ca_cert.subject).public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=10))
            .not_valid_after(now - timedelta(days=1) if expired else now + timedelta(days=1))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False,
                                        key_encipherment=False, data_encipherment=False, key_agreement=False,
                                        key_cert_sign=False, crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.SubjectAlternativeName(names), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
            .sign(ca_key, hashes.SHA256()))
    cert_path, key_path = folder / f"server-{number}.pem", folder / f"server-{number}.key"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                          serialization.NoEncryption()))
    return cert_path, key_path


@pytest.fixture
def tls_lab(tmp_path, monkeypatch):
    """No test can connect beyond its own ephemeral IPv4 loopback listeners."""
    servers, threads, allowed, connections, contexts = [], [], set(), [], []
    authorities = {name: _authority(tmp_path, name) for name in ("bundled", "platform", "untrusted")}
    real_connect = socket.create_connection

    def owned_connect(address, *args, **kwargs):
        if address[0] != "127.0.0.1" or address[1] not in allowed:
            pytest.fail(f"Update TLS test attempted an unowned connection: {address}")
        connections.append(address)
        return real_connect(address, *args, **kwargs)

    monkeypatch.setattr(socket, "create_connection", owned_connect)
    monkeypatch.setattr(urllib.request, "getproxies", lambda: {})
    monkeypatch.setattr(certifi, "where", lambda: str(authorities["bundled"][2]))

    def platform_trust(*names):
        def default_context(*args, **kwargs):
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            # Mirror current secure defaults without inheriting the test host's
            # trust store. The production helper must append bundled trust.
            if hasattr(ssl, "VERIFY_X509_STRICT"):
                context.verify_flags |= ssl.VERIFY_X509_STRICT
            for name in names:
                context.load_verify_locations(cafile=str(authorities[name][2]))
            contexts.append(context)
            return context
        monkeypatch.setattr(ssl, "create_default_context", default_context)

    def start(authority="bundled", *, wrong_hostname=False, expired=False, plaintext=False):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.server.requests.append(self.path)
                redirect = self.server.redirects.get(self.path)
                body = b'{"version":"2.0.0"}'
                self.send_response(302 if redirect else 200)
                if redirect:
                    self.send_header("Location", redirect)
                self.send_header("Content-Length", "0" if redirect else str(len(body)))
                self.end_headers()
                if not redirect:
                    self.wfile.write(body)

            def log_message(self, *args):
                pass

        class Server(ThreadingHTTPServer):
            allow_reuse_address = False
            daemon_threads = True

        server = Server(("127.0.0.1", 0), Handler)
        try:
            if not plaintext:
                cert, key = _leaf(tmp_path, authorities[authority], len(servers),
                                  wrong_hostname=wrong_hostname, expired=expired)
                context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                context.load_cert_chain(str(cert), str(key))
                server.socket = context.wrap_socket(server.socket, server_side=True)
            server.requests, server.redirects = [], {}
            server.url = f"{'http' if plaintext else 'https'}://127.0.0.1:{server.server_port}"
            allowed.add(server.server_port)
            thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
            thread.start()
        except BaseException:
            server.server_close()
            raise
        servers.append(server)
        threads.append(thread)
        return server

    platform_trust()
    yield start, platform_trust, connections, contexts
    for server in servers:
        server.shutdown()
        server.server_close()
    for thread in threads:
        thread.join(timeout=3)
        assert not thread.is_alive(), "Loopback TLS server did not stop"


def _read(url):
    with U._open_url(url, timeout=3) as response:
        return response.read()


def _verification_failure(url):
    with pytest.raises(URLError) as failure:
        _read(url)
    assert isinstance(failure.value.reason, ssl.SSLCertVerificationError)
    return failure.value.reason


def test_bundled_ca_works_when_platform_trust_is_empty(tls_lab):
    start, _, _, contexts = tls_lab
    server = start()
    assert _read(server.url + "/downloads.json") == b'{"version":"2.0.0"}'
    assert server.requests == ["/downloads.json"]
    assert contexts[-1].verify_mode == ssl.CERT_REQUIRED
    assert contexts[-1].check_hostname is True


def test_platform_trust_remains_available_alongside_distinct_bundled_ca(tls_lab):
    start, platform_trust, _, contexts = tls_lab
    platform_trust("platform")
    platform_server, bundled_server = start("platform"), start("bundled")
    assert _read(platform_server.url + "/platform")
    assert _read(bundled_server.url + "/bundled")
    assert contexts[-1].cert_store_stats()["x509_ca"] == 2


@pytest.mark.parametrize("options", [{"authority": "untrusted"}, {"wrong_hostname": True}, {"expired": True}])
def test_invalid_chain_hostname_or_expiration_is_rejected(tls_lab, options):
    start, _, _, _ = tls_lab
    server = start(**options)
    _verification_failure(server.url + "/downloads.json")
    assert server.requests == []


def test_https_redirect_uses_the_same_verified_trust_context(tls_lab):
    start, platform_trust, _, contexts = tls_lab
    platform_trust("platform")
    initial, destination = start("bundled"), start("platform")
    initial.redirects["/redirect"] = destination.url + "/release.zip"
    assert _read(initial.url + "/redirect")
    assert initial.requests == ["/redirect"] and destination.requests == ["/release.zip"]
    assert len(contexts) == 1


@pytest.mark.parametrize("options", [{"authority": "untrusted"}, {"wrong_hostname": True}, {"expired": True}])
def test_https_redirect_does_not_bypass_certificate_checks(tls_lab, options):
    start, _, _, _ = tls_lab
    initial, destination = start(), start(**options)
    initial.redirects["/redirect"] = destination.url + "/release.zip"
    _verification_failure(initial.url + "/redirect")
    assert initial.requests == ["/redirect"] and destination.requests == []


def test_http_downgrade_and_initial_http_url_are_refused_before_connecting(tls_lab):
    start, _, connections, _ = tls_lab
    initial, plaintext = start(), start(plaintext=True)
    initial.redirects["/redirect"] = plaintext.url + "/release.zip"
    with pytest.raises(ValueError, match="HTTPS"):
        _read(initial.url + "/redirect")
    with pytest.raises(ValueError, match="HTTPS"):
        _read(plaintext.url + "/downloads.json")
    assert initial.requests == ["/redirect"]
    assert plaintext.requests == []
    assert all(address[1] != plaintext.server_port for address in connections)
