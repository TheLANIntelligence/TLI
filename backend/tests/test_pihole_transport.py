"""Owned loopback TLS and synthetic Pi-hole v6 protocol acceptance only."""
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
from urllib.parse import quote, urlencode

import pytest
from fastapi import HTTPException
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

import pihole_transport as P

PASSWORD = "synthetic-password-never-reflect"
SID = "synthetic+SID/never=reflect"
CLIENT = {"id": 7, "client": "192.168.50.24", "comment": "Living room", "groups": [0, 3],
          "date_added": 1700000000, "date_modified": 1700000001, "unknown_private": "discard"}
GROUP = {"id": 0, "name": "Default", "comment": None, "enabled": True,
         "date_added": 1700000000, "date_modified": 1700000001}
QUERY = {"time": 1700000000.5, "domain": "example.test", "type": "A", "status": "GRAVITY",
         "client": {"ip": CLIENT["client"], "name": "television"},
         "reply": {"type": "IP", "time": 1.25}, "upstream": "discard"}


def allow():
    pass


@pytest.fixture
def remote(tmp_path):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "pihole-fixture")])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=1))
            .not_valid_after(now + timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), False)
            .sign(key, hashes.SHA256()))
    certificate, private_key = tmp_path / "certificate.pem", tmp_path / "private.key"
    certificate.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    private_key.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                            serialization.NoEncryption()))
    state = {"calls": [], "data": {"clients": [copy.deepcopy(CLIENT)]}, "body": None, "status": 200,
             "headers": {}, "before": None, "delay": 0, "trickle": 0, "length": True}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def dispatch(self):
            request_body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            state["calls"].append((self.command, self.path, dict(self.headers), request_body))
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
            except OSError:
                pass

        do_GET = do_POST = do_PUT = do_DELETE = dispatch

    class Server(ThreadingHTTPServer):
        daemon_threads = True

        def handle_error(self, *args):
            pass

    server = Server(("127.0.0.1", 0), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certificate, private_key)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": .02}, daemon=True)
    thread.start()
    state.update(origin=f"https://127.0.0.1:{server.server_port}", certificate=certificate,
                 fingerprint=hashlib.sha256(cert.public_bytes(serialization.Encoding.DER)).hexdigest())
    try:
        yield state
    finally:
        server.shutdown()
        server.server_close()
        thread.join(2)


def call(remote, method="GET", path="/api/clients", check=allow, **kwargs):
    kwargs.setdefault("sid", SID if method != "POST" else None)
    return P.exchange(P.configuration(remote["origin"], remote["fingerprint"]), method, path, check, **kwargs)


def query_path(**updates):
    now = int(time.time())
    values = {"client_ip": CLIENT["client"], "length": 100, "from": now - 900, "until": now, "disk": "false"}
    values.update(updates)
    return "/api/queries?" + urlencode(values)


def test_owned_tls_methods_headers_no_dns_proxy_or_persistence(remote, monkeypatch, tmp_path):
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("ALL_PROXY", "http://127.0.0.1:1")
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: pytest.fail("No DNS allowed"))
    before = {path.name: path.read_bytes() for path in tmp_path.iterdir()}
    remote["data"] = {"session": {"sid": SID, "valid": True, "validity": 300, "csrf": "discard"}}
    assert P.validate_session(call(remote, "POST", "/api/auth", body={"password": PASSWORD})) == {"sid": SID, "validity": 300}
    remote["data"] = {"clients": [CLIENT]}
    assert call(remote) == remote["data"]
    remote["data"] = {"groups": [GROUP]}
    call(remote, path="/api/groups")
    remote["data"] = {"queries": [QUERY]}
    call(remote, path=query_path())
    attempts = []
    remote["data"] = {"clients": [{**CLIENT, "groups": []}], "processed": {"success": [{"item": CLIENT["client"]}], "errors": []}}
    call(remote, "PUT", "/api/clients/" + CLIENT["client"], body={"comment": CLIENT["comment"], "groups": []}, on_attempt=lambda: attempts.append(True))
    remote["status"], remote["body"] = 204, b""
    assert call(remote, "DELETE", "/api/auth") == {}
    assert [row[0] for row in remote["calls"]] == ["POST", "GET", "GET", "GET", "PUT", "DELETE"]
    for method, path, headers, body in remote["calls"]:
        assert not any(key.lower() in {"cookie", "authorization", "x-tli-session", "x-api-key"} for key in headers)
        if method == "POST":
            assert json.loads(body) == {"password": PASSWORD}
            assert "X-FTL-SID" not in headers
        else:
            assert headers["X-FTL-SID"] == SID and PASSWORD not in body.decode()
        assert SID not in path and PASSWORD not in path
    assert attempts == [True]
    assert before == {path.name: path.read_bytes() for path in tmp_path.iterdir()}


def test_tls_pin_failure_or_untrusted_pki_sends_no_password_or_put(remote):
    attempts = []
    for pin in ("00" * 32, ""):
        config = P.configuration(remote["origin"], pin)
        with pytest.raises(HTTPException) as error:
            P.exchange(config, "POST", "/api/auth", allow, body={"password": PASSWORD})
        assert error.value.status_code == 502
        with pytest.raises(HTTPException):
            P.exchange(config, "PUT", "/api/clients/" + CLIENT["client"], allow, sid=SID,
                       body={"comment": None, "groups": []}, on_attempt=lambda: attempts.append(True))
    assert remote["calls"] == [] and attempts == []


def test_pki_uses_system_verification_for_ip_certificate(remote, monkeypatch):
    original = ssl.create_default_context
    monkeypatch.setattr(P.ssl, "create_default_context", lambda: original(cafile=str(remote["certificate"])))
    config = P.configuration(remote["origin"])
    assert P.exchange(config, "GET", "/api/clients", allow, sid=SID) == remote["data"]


@pytest.mark.parametrize("origin", ["http://192.168.1.2", "https://pi.hole", "https://8.8.8.8", "https://169.254.1.2",
                                      "https://[fe80::1]", "https://user@192.168.1.2", "https://192.168.1.2/",
                                      "https://192.168.1.2?x=y", "https://192.168.1.2:0", "https://192.168.1.2:65536",
                                      "https://[::ffff:192.168.1.2]", "https://[fc00::1%25eth0]"])
def test_origin_boundary(origin):
    with pytest.raises(HTTPException) as error:
        P.configuration(origin)
    assert error.value.status_code == 422


def test_configuration_canonical_port_and_fingerprint():
    assert P.configuration("https://[FD00:0::1]")["origin"] == "https://[fd00::1]:443"
    assert P.configuration("https://192.168.2.2", ":".join(["AB"] * 32))["fingerprint"] == "ab" * 32
    for pin in (None, True, "00", "g" * 64):
        with pytest.raises(HTTPException):
            P.configuration("https://192.168.2.2", pin)


@pytest.mark.parametrize("method,path,body", [
    ("GET", "/api/config", None), ("GET", "/api/clients/192.168.50.24", None),
    ("POST", "/api/dns/blocking", {"blocking": False}), ("POST", "/api/clients", {"client": "192.168.1.2"}),
    ("DELETE", "/api/clients/192.168.1.2", None), ("PUT", "/api/clients/192.168.50.0%2F24", {"groups": [], "comment": None}),
    ("PUT", "/api/clients/8.8.8.8", {"groups": [], "comment": None}),
    ("PUT", "/api/clients/192.168.50.24", {"groups": []}),
    ("PUT", "/api/clients/192.168.50.24", {"groups": [True], "comment": None}),
    ("PUT", "/api/clients/192.168.50.24", {"groups": [1, 1], "comment": None}),
    ("GET", "/api/clients", {"password": PASSWORD}),
])
def test_fixed_endpoint_and_body_boundary_precedes_network(monkeypatch, method, path, body):
    monkeypatch.setattr(socket, "socket", lambda *a, **k: pytest.fail("Must reject before connect"))
    with pytest.raises(HTTPException) as error:
        P.exchange(P.configuration("https://192.168.50.2"), method, path, allow, sid=SID, body=body)
    assert error.value.status_code == 422


@pytest.mark.parametrize("updates", [{"client_ip": "192.168.*"}, {"length": 101}, {"length": -1}, {"disk": "true"},
                                   {"from": 0}, {"cursor": -1}, {"until": 999999999999}, {"extra": "x"}])
def test_recent_activity_query_bounds(updates):
    with pytest.raises(HTTPException):
        P._request("GET", query_path(**updates), SID, None)


def test_duplicate_query_parameter_and_sid_control_characters_rejected():
    with pytest.raises(HTTPException):
        P._request("GET", query_path() + "&client_ip=192.168.1.3", SID, None)
    with pytest.raises(HTTPException):
        P._request("GET", "/api/clients", SID + "\r\nX-Injected: x", None)
    with pytest.raises(HTTPException):
        P._request("POST", "/api/auth", None, {"password": PASSWORD, "totp": 123456})


@pytest.mark.parametrize("status", [301, 302, 307, 401, 403, 404, 500])
def test_remote_errors_redacted_no_redirect_or_retry(remote, status):
    remote.update(status=status, body=(PASSWORD + SID).encode(), headers={"Location": "https://127.0.0.1:1/" + PASSWORD})
    with pytest.raises(HTTPException) as error:
        call(remote)
    assert error.value.status_code == 502
    assert PASSWORD not in str(error.value.detail) and SID not in str(error.value.detail)
    assert len(remote["calls"]) == 1


@pytest.mark.parametrize("body", [b'{"clients":[],"clients":[]}', b'{"clients":NaN}', b'{"clients":Infinity}',
                                 b'{"error":{"hint":"synthetic-password-never-reflect"}}', b'[]', b'\xff'])
def test_bad_json_cannot_become_empty_success(remote, body):
    remote["body"] = body
    with pytest.raises(HTTPException) as error:
        call(remote)
    assert error.value.status_code == 502 and PASSWORD not in str(error.value.detail)


@pytest.mark.parametrize("headers", [{"Content-Length": str(P.MAX_RESPONSE + 1)}, {"Content-Encoding": "gzip"},
                                    {"Content-Type": "text/html"}, {"Content-Length": "999999"},
                                    {"Transfer-Encoding": "chunked"}])
def test_bounded_framing_and_type(remote, headers):
    remote["headers"] = headers
    with pytest.raises(HTTPException) as error:
        call(remote)
    assert error.value.status_code == 502


def test_streaming_size_limit_without_content_length(remote, monkeypatch):
    monkeypatch.setattr(P, "MAX_RESPONSE", 128)
    remote.update(length=False, body=b'{' + b' ' * 256 + b'}')
    with pytest.raises(HTTPException) as error:
        call(remote)
    assert error.value.status_code == 502


def test_deadline_stops_trickling_body(remote, monkeypatch):
    monkeypatch.setattr(P, "REQUEST_TIMEOUT", .12)
    remote.update(trickle=.03, body=b'{"clients":[]}')
    started = time.monotonic()
    with pytest.raises(HTTPException) as error:
        call(remote)
    assert error.value.status_code == 504 and time.monotonic() - started < 1


def test_revocation_after_response_denies_data_and_errors(remote):
    alive = [True]
    def check():
        if not alive[0]:
            raise HTTPException(403, "revoked")
    remote["before"] = lambda: alive.__setitem__(0, False)
    for status in (200, 500):
        alive[0], remote["status"] = True, status
        with pytest.raises(HTTPException) as error:
            call(remote, check=check)
        assert error.value.status_code == 403


def test_submission_callback_happens_after_tls_before_bytes_and_rechecks_authority(remote):
    alive, attempts = [True], []
    def check():
        if not alive[0]:
            raise HTTPException(403, "revoked")
    def attempted():
        assert remote["calls"] == []
        attempts.append(True)
        alive[0] = False
    with pytest.raises(HTTPException) as error:
        call(remote, "PUT", "/api/clients/" + CLIENT["client"], check,
             body={"groups": [], "comment": None}, on_attempt=attempted)
    assert error.value.status_code == 403 and attempts == [True] and remote["calls"] == []


def test_absent_unavailable_authority_and_capacity_no_connection(monkeypatch):
    monkeypatch.setattr(socket, "socket", lambda *a, **k: pytest.fail("Must not connect"))
    def unavailable():
        raise OSError("private path")
    for check in (None, unavailable):
        with pytest.raises(HTTPException) as error:
            P.exchange(P.configuration("https://192.168.1.2"), "GET", "/api/clients", check, sid=SID)
        assert error.value.status_code == 403 and "private path" not in str(error.value.detail)
    slots = threading.BoundedSemaphore(1)
    slots.acquire()
    monkeypatch.setattr(P, "HTTP_SLOTS", slots)
    with pytest.raises(HTTPException) as error:
        P.exchange(P.configuration("https://192.168.1.2"), "GET", "/api/clients", allow, sid=SID)
    assert error.value.status_code == 429


def test_strict_projection_detaches_fields_and_keeps_empty_membership():
    source = copy.deepcopy(CLIENT)
    source["groups"] = []
    result = P.project_clients({"clients": [source]})[0]
    assert result["groups"] == [] and result["comment"] == "Living room" and result["editable"] is True
    assert "unknown_private" not in result
    source["groups"].append(3)
    assert result["groups"] == []
    group = P.project_groups({"groups": [GROUP]})[0]
    assert group["description"] is None and group["enabled"] is True and "comment" not in group
    activity = P.project_queries({"queries": [QUERY], "cursor": 33, "recordsFiltered": 1}, CLIENT["client"])
    assert activity["items"][0]["domain"] == "example.test" and activity["records_filtered"] == 1
    assert "upstream" not in activity["items"][0]


@pytest.mark.parametrize("selector", ["192.168.0.0/24", "00:11:22:33:44:55", "television", ":eth0", "127.0.0.1", "8.8.8.8"])
def test_nonspecific_or_nonlan_selectors_are_observation_only(selector):
    assert P.project_clients({"clients": [{**CLIENT, "client": selector}]})[0]["editable"] is False


@pytest.mark.parametrize("field,value", [("id", True), ("groups", [True]), ("groups", None), ("groups", [0, 0]),
                                        ("comment", "bad\ud800"), ("client", "192.168.1.2\n"),
                                        ("comment", "direction\u202e"), ("date_added", -1)])
def test_malformed_clients_fail_closed(field, value):
    with pytest.raises(HTTPException) as error:
        P.project_clients({"clients": [{**CLIENT, field: value}]})
    assert error.value.status_code == 502


def test_duplicate_canonical_clients_and_excess_inventory_fail_closed():
    first = {**CLIENT, "client": "fd00::1"}
    second = {**CLIENT, "id": 8, "client": "fd00:0::1"}
    for data in ({"clients": [CLIENT, CLIENT]}, {"clients": [first, second]},
                 {"clients": [CLIENT] * (P.MAX_CLIENTS + 1)}, {"clients": None}, {"error": "bad", "clients": []}):
        with pytest.raises(HTTPException):
            P.project_clients(data)


def test_group_shape_and_identity_must_be_unambiguous():
    for rows in ([GROUP, GROUP], [{**GROUP, "enabled": 1}], [{**GROUP, "comment": "bad\ntext"}], [{}]):
        with pytest.raises(HTTPException):
            P.project_groups({"groups": rows})


def test_activity_filter_is_verified_and_nonfinite_data_denied():
    invalid = [{**QUERY, "client": {"ip": "192.168.50.25"}}, {**QUERY, "time": float("nan")},
               {**QUERY, "time": True}, {**QUERY, "domain": "bad\ud800"}, {**QUERY, "status": {}},
               {**QUERY, "reply": {"type": "IP", "time": float("inf")}}]
    for query in invalid:
        with pytest.raises(HTTPException) as error:
            P.project_queries({"queries": [query]}, CLIENT["client"])
        assert error.value.status_code == 502
    with pytest.raises(HTTPException):
        P.project_queries({"queries": [QUERY] * 101}, CLIENT["client"])
    assert P.project_queries({"queries": []}, CLIENT["client"]) == {"items": [], "cursor": None, "records_filtered": None}


def test_session_does_not_accept_unprotected_or_invalid_auth():
    for session in ({"valid": True, "sid": None, "validity": -1}, {"valid": False, "sid": SID, "validity": 300},
                    {"valid": True, "sid": SID, "validity": True}, {"valid": True, "sid": SID, "validity": 0}):
        with pytest.raises(HTTPException):
            P.validate_session({"session": session})


def test_activity_verifies_requested_time_window_and_ipv6_identity():
    query = {**QUERY, "time": 500, "client": {"ip": "fd00::1", "name": None}}
    assert P.project_queries({"queries": [query]}, "fd00:0::1", start=100, until=1000)["items"][0]["client"]["ip"] == "fd00::1"
    for bounds in ({"start": 501, "until": 1000}, {"start": 0, "until": 499},
                   {"start": 0, "until": 901}, {"start": None, "until": 1000}):
        with pytest.raises(HTTPException):
            P.project_queries({"queries": [query]}, "fd00::1", **bounds)
