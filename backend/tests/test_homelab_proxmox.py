"""Synthetic-only inventory and owned loopback TLS transport acceptance."""
import copy
import hashlib
import ipaddress
import json
import socket
import ssl
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi import HTTPException
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

import homelab_proxmox as H

TOKEN_ID = "observer@pve!tli-readonly"
SECRET = "synthetic-private-token-91e720d4"
DATA = {"data": [
    {"id": "node/pve1", "type": "node", "node": "pve1", "status": "online", "cpu": .125,
     "maxcpu": 8, "mem": 1024, "maxmem": 8192, "uptime": 800, "secret_attribute": "excluded"},
    {"id": "qemu/100", "type": "qemu", "name": "files", "node": "pve1", "status": "running", "vmid": 100},
    {"id": "lxc/101", "type": "lxc", "name": "dns", "status": "stopped", "cpu": 0},
    {"id": "storage/pve1/local", "type": "storage", "storage": "local", "disk": 20, "maxdisk": 100, "shared": 0},
]}


def payload(origin="https://192.168.25.10:8006", fingerprint=""):
    return {"origin": origin, "token_id": TOKEN_ID, "token_secret": SECRET, "certificate_sha256": fingerprint}


def allow():
    pass


@pytest.fixture
def remote(tmp_path):
    """Create and tear down only this test's localhost TLS listener."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "proxmox-fixture")])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=1))
            .not_valid_after(now+timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), False)
            .sign(key, hashes.SHA256()))
    cert_path, key_path = tmp_path / "certificate.pem", tmp_path / "private.key"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                         serialization.NoEncryption()))
    state = {"calls": [], "data": copy.deepcopy(DATA), "status": 200, "headers": {}, "before": None,
             "body": None, "delay": 0, "trickle": 0, "length": True}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            state["calls"].append((self.command, self.path, dict(self.headers)))
            if state["before"]:
                state["before"]()
            if state["delay"]:
                time.sleep(state["delay"])
            body = state["body"] if state["body"] is not None else json.dumps(state["data"]).encode()
            try:
                self.send_response(state["status"])
                headers = {"Content-Type": "application/json", **state["headers"]}
                if state["length"]:
                    headers.setdefault("Content-Length", str(len(body)))
                for header, value in headers.items():
                    self.send_header(header, value)
                self.end_headers()
                if state["trickle"]:
                    for byte in body:
                        self.wfile.write(bytes([byte]))
                        self.wfile.flush()
                        time.sleep(state["trickle"])
                else:
                    self.wfile.write(body)
            except (OSError, ssl.SSLError):
                pass  # A cancelled client is expected in access/deadline tests.

    class Server(ThreadingHTTPServer):
        daemon_threads = True

        def handle_error(self, *args):
            pass

    server = Server(("127.0.0.1", 0), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert_path, key_path)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": .02}, daemon=True)
    thread.start()
    state.update(origin=f"https://127.0.0.1:{server.server_port}", certificate=cert_path,
                 fingerprint=hashlib.sha256(cert.public_bytes(serialization.Encoding.DER)).hexdigest())
    try:
        yield state
    finally:
        server.shutdown()
        server.server_close()
        thread.join(2)


def run_remote(remote, check=allow):
    return H.inspect(payload(remote["origin"], remote["fingerprint"]), check)


def test_one_pinned_get_has_no_dns_proxy_or_persistence(remote, monkeypatch, tmp_path):
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("ALL_PROXY", "http://127.0.0.1:1")
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: pytest.fail("Literal transport must not resolve DNS"))
    before = {path.name: path.read_bytes() for path in tmp_path.iterdir()}
    result = run_remote(remote)
    assert result["ok"] and result["actions_performed"] is False
    assert result["tls_verification"] == "certificate_pin"
    assert result["counts"] == {"nodes": 1, "virtual_machines": 1, "containers": 1, "storage": 1, "other": 0, "total": 4}
    assert result["resources"][0]["cpu"] == .125
    assert "mem" not in result["resources"][1]  # Missing is unknown, not zero.
    assert result["resources"][2]["cpu"] == 0
    assert result["resources"][3]["shared"] is False
    assert result["origin"] == remote["origin"] and result["checked_at"].endswith("Z")
    serialized = json.dumps(result)
    assert SECRET not in serialized and TOKEN_ID not in serialized and "secret_attribute" not in serialized
    assert len(remote["calls"]) == 1
    method, path, headers = remote["calls"][0]
    assert (method, path) == ("GET", "/api2/json/cluster/resources")
    assert headers["Authorization"] == f"PVEAPIToken={TOKEN_ID}={SECRET}"
    assert not any(key.lower() in {"cookie", "x-tli-session", "x-api-key"} for key in headers)
    assert before == {path.name: path.read_bytes() for path in tmp_path.iterdir()}


def test_pin_mismatch_and_untrusted_default_send_no_token(remote):
    for fingerprint in ("00" * 32, ""):
        with pytest.raises(HTTPException) as caught:
            H.inspect(payload(remote["origin"], fingerprint), allow)
        assert caught.value.status_code == 502
        assert remote["calls"] == []


def test_default_pki_works_with_trusted_ip_certificate(remote, monkeypatch):
    create = ssl.create_default_context
    monkeypatch.setattr(H.ssl, "create_default_context", lambda: create(cafile=str(remote["certificate"])))
    result = H.inspect(payload(remote["origin"]), allow)
    assert result["tls_verification"] == "system_trust" and len(remote["calls"]) == 1


def test_access_revocation_after_tls_sends_no_token(remote, monkeypatch):
    revoked = False
    handshake = ssl.SSLSocket.do_handshake

    def wrapped(sock, *args, **kwargs):
        nonlocal revoked
        result = handshake(sock, *args, **kwargs)
        if not sock.server_side:
            revoked = True
        return result

    def check():
        if revoked:
            raise HTTPException(401, "Fixture access revoked")

    monkeypatch.setattr(ssl.SSLSocket, "do_handshake", wrapped)
    with pytest.raises(HTTPException) as caught:
        run_remote(remote, check)
    assert caught.value.status_code == 401 and remote["calls"] == []


@pytest.mark.parametrize("status", [200, 403, 500, 302])
def test_access_revocation_supersedes_success_or_upstream_failure(remote, status):
    revoked = False

    def revoke():
        nonlocal revoked
        revoked = True

    def check():
        if revoked:
            raise HTTPException(401, "Fixture access revoked")

    remote.update(before=revoke, status=status)
    with pytest.raises(HTTPException) as caught:
        run_remote(remote, check)
    assert caught.value.status_code == 401 and len(remote["calls"]) == 1


@pytest.mark.parametrize("status", [301, 302, 307, 308, 401, 403, 500])
def test_remote_errors_are_redacted_and_never_redirect_or_retry(remote, status):
    remote.update(status=status, body=(SECRET + TOKEN_ID + "upstream private error").encode(),
                  headers={"Location": "https://192.168.25.9:8006/secret"})
    with pytest.raises(HTTPException) as caught:
        run_remote(remote)
    assert caught.value.status_code == 502 and len(remote["calls"]) == 1
    assert SECRET not in str(caught.value) and TOKEN_ID not in str(caught.value)
    assert "upstream private error" not in str(caught.value)


@pytest.mark.parametrize("url", ["http://192.168.1.1:8006", "https://pve.local:8006", "https://8.8.8.8", "https://0.0.0.0",
    "https://169.254.169.254", "https://224.1.1.1", "https://[fe80::1]", "https://[::]", "https://[2001:4860:4860::8888]",
    "https://[::ffff:127.0.0.1]", "https://192.168.1.1/", "https://192.168.1.1/path", "https://192.168.1.1?",
    "https://192.168.1.1#", "https://user:pass@192.168.1.1", "https://127.0.0.1:", "https://127.0.0.1:0",
    "https://127.0.0.1:65536", "https://127.0.0.1\n", "https://[::1%1]:8006", "https://127.1:8006"])
def test_invalid_origin_never_connects(monkeypatch, url):
    monkeypatch.setattr(H, "_fetch", lambda *a: pytest.fail("Invalid origin contacted transport"))
    with pytest.raises(HTTPException) as caught:
        H.inspect(payload(url), allow)
    assert caught.value.status_code == 422


@pytest.mark.parametrize("origin, expected", [("https://192.168.1.1", "https://192.168.1.1:8006"),
    ("https://[fd00::1]:8007", "https://[fd00::1]:8007"), ("https://[::1]", "https://[::1]:8006")])
def test_private_literal_origin_canonicalization(origin, expected):
    assert H._configuration(payload(origin))["origin"] == expected


@pytest.mark.parametrize("patch", [{"token_id": "root@pam"}, {"token_id": "x@pve!token\nInjected: secret"},
    {"token_secret": "a\r\nb"}, {"token_secret": ""}, {"certificate_sha256": "bad"}, {"method": "POST"},
    {"token_secret": None}, {"certificate_sha256": None}])
def test_invalid_payload_never_connects(monkeypatch, patch):
    monkeypatch.setattr(H, "_fetch", lambda *a: pytest.fail("Invalid payload contacted transport"))
    with pytest.raises(HTTPException) as caught:
        H.inspect({**payload(), **patch}, allow)
    assert caught.value.status_code == 422


@pytest.mark.parametrize("data", [{}, {"data": {}}, {"data": [None]}, {"data": [{"id": "node/a"}]},
    {"data": [{"id": "a", "type": "future"}]}, {"data": DATA["data"] * 2}, {"data": [DATA["data"][0]] * 2001},
    {"data": [], "errors": {"private": SECRET}}])
def test_invalid_inventory_is_not_empty_or_partial_success(monkeypatch, data):
    monkeypatch.setattr(H, "_fetch", lambda *a: data)
    with pytest.raises(HTTPException) as caught:
        H.inspect(payload(), allow)
    assert caught.value.status_code == 502


def test_unknown_metrics_and_credential_echoes_are_omitted(monkeypatch):
    data = {"data": [{"id": "node/pve", "type": "node", "cpu": 2, "maxcpu": False, "mem": -1,
                      "maxmem": None, "disk": "200", "maxdisk": 2**60, "uptime": True,
                      "name": "reflected " + SECRET, "status": TOKEN_ID, "shared": "false"}]}
    monkeypatch.setattr(H, "_fetch", lambda *a: data)
    assert H.inspect(payload(), allow)["resources"] == [{"id": "node/pve", "type": "node"}]


@pytest.mark.parametrize("body, headers", [(b'{"data":[],"data":[]}', {}), (b'{"data":NaN}', {}),
    (b'{"data":[', {}), (b'{}', {"Content-Encoding": "gzip"}), (b'{}', {"Content-Type": "text/html"}),
    (b'{}', {"Content-Length": str(H.MAX_RESPONSE+1)}), (b'{}', {"Content-Length": "100"})])
def test_bad_responses_are_bounded_and_redacted(remote, body, headers):
    remote.update(body=body, headers=headers)
    with pytest.raises(HTTPException) as caught:
        run_remote(remote)
    assert caught.value.status_code == 502


def test_stream_size_limit_without_content_length(remote, monkeypatch):
    monkeypatch.setattr(H, "MAX_RESPONSE", 128)
    remote.update(body=b" " * 129, length=False)
    with pytest.raises(HTTPException) as caught:
        run_remote(remote)
    assert caught.value.status_code == 502


def test_request_deadline_and_slot_release(remote, monkeypatch):
    monkeypatch.setattr(H, "REQUEST_TIMEOUT", .15)
    remote["delay"] = .4
    began = time.monotonic()
    with pytest.raises(HTTPException) as caught:
        run_remote(remote)
    assert caught.value.status_code == 504 and time.monotonic()-began < 1
    for _ in range(4):
        assert H.HTTP_SLOTS.acquire(False)
    for _ in range(4):
        H.HTTP_SLOTS.release()


def test_slow_trickle_cannot_extend_aggregate_deadline(remote, monkeypatch):
    monkeypatch.setattr(H, "REQUEST_TIMEOUT", .18)
    monkeypatch.setattr(H, "IO_TIMEOUT", .10)
    remote.update(trickle=.035, body=b'{"data":[]}')
    began = time.monotonic()
    with pytest.raises(HTTPException) as caught:
        run_remote(remote)
    assert caught.value.status_code == 504 and time.monotonic()-began < 1
    assert len(remote["calls"]) == 1


def test_concurrency_limit_checks_access_and_never_connects(monkeypatch):
    slots = threading.BoundedSemaphore(1)
    slots.acquire()
    monkeypatch.setattr(H, "HTTP_SLOTS", slots)
    checks = []
    with pytest.raises(HTTPException) as caught:
        H.inspect(payload(), lambda: checks.append(True))
    assert caught.value.status_code == 429 and len(checks) >= 3


def test_missing_or_failed_authority_cannot_read_or_disclose(monkeypatch):
    monkeypatch.setattr(H, "_fetch", lambda *a: pytest.fail("No authority"))
    for check in (None, lambda: (_ for _ in ()).throw(OSError(SECRET))):
        with pytest.raises(HTTPException) as caught:
            H.inspect(payload(), check)
        assert caught.value.status_code == 403 and SECRET not in str(caught.value)


def test_final_disclosure_rechecks_original_authority(monkeypatch):
    revoked = False
    original = H._resources

    def resources(*args):
        nonlocal revoked
        result = original(*args)
        revoked = True
        return result

    def check():
        if revoked:
            raise HTTPException(401, "Fixture revoked")

    monkeypatch.setattr(H, "_fetch", lambda *a: DATA)
    monkeypatch.setattr(H, "_resources", resources)
    with pytest.raises(HTTPException) as caught:
        H.inspect(payload(), check)
    assert caught.value.status_code == 401
