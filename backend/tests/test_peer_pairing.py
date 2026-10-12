"""Two synthetic computers and in-process transport; no live LAN traffic."""
import copy
import json
import time
from collections import deque
from contextlib import contextmanager
from types import SimpleNamespace as NS
from urllib.parse import urlsplit

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request

import node_identity
import peer_pairing as Q
import peer_trust as P
import tli_state as S
from routers import peer_pairing_routes
from tests.test_peer_trust import computer


def request(host="127.0.0.1", *, token="browser-token", hostname="localhost", scheme="https", headers=None):
    values = {"host": hostname, **(headers or {})}
    if token:
        values["cookie"] = "tli_session=" + token
    return Request({"type": "http", "method": "POST", "scheme": scheme, "server": (hostname, 443),
                    "path": "/", "root_path": "", "query_string": b"", "client": (host, 12345),
                    "headers": [(k.encode(), v.encode()) for k, v in values.items()]})


def sign(key, kind, **values):
    result = {"protocol": Q.PROTOCOL, "kind": kind, **values}
    result["signature"] = key.sign(P.canonical(result)).hex()
    return result


@pytest.fixture()
def pair(tmp_path, monkeypatch):
    sides = {}
    for name, address in (("a", "192.168.2.10"), ("b", "192.168.2.20")):
        key, card = computer("computer-" + name, address)
        root = tmp_path / name
        root.mkdir()
        cfg = S.NodeConfig(node_id=card["node_id"], node_name=card["name"], role="host", mesh_status="approved",
                           created_at="synthetic", updated_at="synthetic")
        config_path = root / "node.json"
        S._security.write_json(config_path, cfg.model_dump(), "synthetic")
        directory_path = root / "directory.json"
        S._security.write_json(directory_path, {}, "synthetic")
        sides[name] = NS(key=key, card=card, cfg=cfg, config_path=config_path, directory_path=directory_path,
                         requests={}, rates={}, global_rate=deque())
    for name, side in sides.items():
        peer = sides["b" if name == "a" else "a"].card
        parsed = urlsplit(peer["origin"])
        S._security.write_json(side.directory_path, {peer["node_id"]: {"status": "pending", "ip": parsed.hostname,
                              "tli_port": parsed.port, "display_name": peer["name"]}}, "synthetic")

    def configure(mp, side):
        mp.setattr(S, "NODE_CONFIG_PATH", side.config_path)
        mp.setattr(S, "MESH_DIRECTORY_PATH", side.directory_path)
        mp.setattr(S, "TLS_ENABLED", True)
        mp.setattr(node_identity, "public_key_hex", lambda: side.card["public_key"])
        mp.setattr(node_identity, "sign", lambda data: side.key.sign(data).hex())
        mp.setattr(P, "local_card", lambda address, **kwargs: copy.deepcopy(side.card))
        mp.setattr(P, "local_setup", lambda req: {"ready": True, "code": "ready", "reason": None,
                   "origins": [side.card["origin"]], "selected_origin": side.card["origin"], "card": copy.deepcopy(side.card)})
        mp.setattr(Q, "_REQUESTS", side.requests)
        mp.setattr(Q, "_RATES", side.rates)
        mp.setattr(Q, "_GLOBAL_RATE", side.global_rate)
        mp.setattr(Q, "_NODE_PAIRING", getattr(side, 'node_window', None))

    @contextmanager
    def active(name):
        with monkeypatch.context() as mp:
            configure(mp, sides[name])
            yield sides[name]

    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    monkeypatch.setattr(S, "validate_session_token", lambda token: token in ("browser-token", "different-token"))
    monkeypatch.setattr(S, "get_session_user_id", lambda token: "owner")
    configure(monkeypatch, sides["a"])
    calls = []

    def exchange(address, path, payload, pin=None, *, source_origin):
        destination = next(name for name, side in sides.items() if side.card["origin"] == address)
        target = sides[destination]
        sender = sides["b" if destination == "a" else "a"]
        assert source_origin == sender.card["origin"]
        assert path in Q._PATHS
        assert pin == (None if path == "/agent/pairing/request" else target.card["certificate_sha256"])
        calls.append((destination, path, copy.deepcopy(payload), pin))
        with active(destination):
            req = request(urlsplit(sender.card["origin"]).hostname, token=None, hostname=urlsplit(address).hostname)
            function = {"/agent/pairing/request": Q.receive, "/agent/pairing/reveal": Q.reveal, "/agent/pairing/status": Q.status}[path]
            return function(copy.deepcopy(payload), req), target.card["certificate_sha256"]

    monkeypatch.setattr(Q, "_exchange", exchange)
    P._PREVIEWS.clear()
    return NS(a=sides["a"], b=sides["b"], active=active, calls=calls, exchange=exchange)


def begin(pair):
    return Q.start(pair.b.card["node_id"], None, "owner", request())["request"]


def test_bilateral_pairing_exchanges_code_but_never_grants_without_local_consent(pair):
    before_a = pair.a.directory_path.read_bytes()
    before_b = pair.b.directory_path.read_bytes()
    outgoing = begin(pair)
    assert outgoing["state"] == "comparing"
    assert len(outgoing["code"]) == 14
    assert pair.a.directory_path.read_bytes() == before_a
    assert pair.b.directory_path.read_bytes() == before_b
    with pair.active("b"):
        incoming = Q.requests("owner", request())["requests"][0]
        assert incoming["code"] == outgoing["code"]
        assert incoming["direction"] == "incoming"
        Q.confirm(incoming["request_id"], incoming["code"], True, "owner", request())
        assert P.trusted(pair.a.card["node_id"], "messages")[0]["peer_trust"]["grants"] == ["messages"]
    assert pair.a.directory_path.read_bytes() == before_a
    Q.confirm(outgoing["request_id"], outgoing["code"], True, "owner", request())
    connected = Q.refresh(outgoing["request_id"], "owner", request())["request"]
    assert connected["state"] == "connected"
    with pair.active("b"):
        assert Q.requests("owner", request())["requests"][0]["state"] == "connected"
    assert len(pair.calls) == 3


@pytest.mark.parametrize("change", ["wrong_code", "no_consent", "other_session", "other_owner", "revoked_session", "blocked", "deleted", "renamed", "local_identity"])
def test_confirmation_fails_closed_when_comparison_authority_or_directory_changes(pair, monkeypatch, change):
    outgoing = begin(pair)
    code, consent, owner, req = outgoing["code"], True, "owner", request()
    if change == "wrong_code": code = "0000-0000-0000"
    if change == "no_consent": consent = False
    if change == "other_session": req = request(token="different-token")
    if change == "other_owner": owner = "different-owner"
    if change == "revoked_session": monkeypatch.setattr(S, "validate_session_token", lambda token: False)
    if change in ("blocked", "deleted", "renamed"):
        directory = S.load_mesh_directory()
        if change == "blocked": directory[pair.b.card["node_id"]]["status"] = "blocked"
        if change == "deleted": del directory[pair.b.card["node_id"]]
        if change == "renamed": directory[pair.b.card["node_id"]]["display_name"] = "Changed during comparison"
        S.save_mesh_directory(directory)
    if change == "local_identity":
        changed = dict(pair.a.card, public_key="1" * 64)
        monkeypatch.setattr(P, "local_card", lambda *args, **kwargs: changed)
    before = pair.a.directory_path.read_bytes()
    with pytest.raises(HTTPException):
        Q.confirm(outgoing["request_id"], code, consent, owner, req)
    assert pair.a.directory_path.read_bytes() == before


def test_presence_updates_do_not_invalidate_comparison(pair):
    outgoing = begin(pair)
    directory = S.load_mesh_directory()
    directory[pair.b.card["node_id"]].update(last_seen="later", discovery={"name": "new hint"})
    S.save_mesh_directory(directory)
    Q.confirm(outgoing["request_id"], outgoing["code"], True, "owner", request())
    assert P.trusted(pair.b.card["node_id"], "messages")


def test_request_and_reveal_replays_and_changed_nonce_fail_without_trust(pair):
    outgoing = begin(pair)
    init, reveal = pair.calls[0][2], pair.calls[1][2]
    with pair.active("b"):
        req = request("192.168.2.10", token=None, hostname="192.168.2.20")
        before = pair.b.directory_path.read_bytes()
        with pytest.raises(HTTPException): Q.receive(init, req)
        with pytest.raises(HTTPException): Q.reveal(reveal, req)
        item = Q._REQUESTS[outgoing["request_id"]]
        item["transcript"] = None
        changed = {k: v for k, v in reveal.items() if k not in ("protocol", "kind", "signature")}
        changed.update(nonce="0" * 64, poll_nonce="c" * 48)
        with pytest.raises(HTTPException): Q.reveal(sign(pair.a.key, "reveal", **changed), req)
        assert pair.b.directory_path.read_bytes() == before


@pytest.mark.parametrize("change", ["certificate", "target", "signature", "nonce", "extra"])
def test_outgoing_rejects_unbound_bootstrap_response(pair, monkeypatch, change):
    def bad_exchange(address, path, payload, pin=None, *, source_origin):
        response, leaf = pair.exchange(address, path, payload, pin, source_origin=source_origin)
        assert path == "/agent/pairing/request"
        if change == "certificate": leaf = "0" * 64
        if change == "target": response["request_id"] = "1" * 48
        if change == "signature": response["signature"] = "0" * 128
        if change == "nonce": response["nonce"] = "1"
        if change == "extra": response["admin"] = True
        return response, leaf
    monkeypatch.setattr(Q, "_exchange", bad_exchange)
    before = pair.a.directory_path.read_bytes()
    with pytest.raises(HTTPException): begin(pair)
    assert pair.a.directory_path.read_bytes() == before
    assert len(pair.calls) == 1


def test_multiple_local_addresses_support_explicit_selection(pair, monkeypatch):
    monkeypatch.setattr(P, "local_setup", lambda req: {"ready": False, "code": "choose_address", "reason": "Choose",
        "origins": [pair.a.card["origin"], "https://192.168.3.10:8443"], "selected_origin": None})
    with pytest.raises(HTTPException) as error:
        begin(pair)
    assert error.value.detail["code"] == "pairing_origin_required"
    assert Q.start(pair.b.card["node_id"], pair.a.card["origin"], "owner", request())["request"]["code"]


def test_outgoing_cancel_notifies_peer_without_persisting_and_allows_new_request(pair):
    outgoing = begin(pair)
    Q.cancel(outgoing["request_id"], "owner", request())
    with pair.active("b"):
        assert Q.requests("owner", request())["requests"][0]["state"] == "cancelled"
        assert not S.load_mesh_directory()[pair.a.card["node_id"]].get("peer_trust")
    assert begin(pair)["request_id"] != outgoing["request_id"]


def test_incoming_cancel_reaches_sender_on_poll(pair):
    outgoing = begin(pair)
    with pair.active("b"):
        Q.requests("owner", request())
        Q.cancel(outgoing["request_id"], "owner", request())
    assert Q.refresh(outgoing["request_id"], "owner", request())["request"]["state"] == "cancelled"


def test_expiration_discards_request_and_prevents_approval(pair):
    outgoing = begin(pair)
    Q._REQUESTS[outgoing["request_id"]]["expires"] = time.monotonic() - 1
    with pytest.raises(HTTPException): Q.confirm(outgoing["request_id"], outgoing["code"], True, "owner", request())
    assert not Q.requests("owner", request())["requests"]


@pytest.mark.parametrize("reason", ["blocked", "reviewed"])
def test_quick_pairing_cannot_replace_existing_trust(pair, reason):
    directory = S.load_mesh_directory()
    if reason == "blocked": directory[pair.b.card["node_id"]]["status"] = "blocked"
    else: directory[pair.b.card["node_id"]]["peer_trust"] = {"card": pair.b.card, "grants": ["observe"]}
    S.save_mesh_directory(directory)
    with pytest.raises(HTTPException) as error: begin(pair)
    assert error.value.detail["code"] == "pairing_manual_review"
    assert not pair.calls


@pytest.mark.parametrize("host,hostname,token,headers,allowed", [
    ("127.0.0.1", "localhost", None, {}, True),
    ("127.0.0.1", "127.0.0.1", None, {}, True),
    ("127.0.0.1", "attacker.example", None, {"origin": "https://attacker.example"}, False),
    ("192.168.2.20", "192.168.2.10", None, {}, False),
    ("192.168.2.20", "192.168.2.10", "browser-token", {}, True),
    ("127.0.0.1", "localhost", "browser-token", {"authorization": "Bearer other"}, False),
    ("127.0.0.1", "localhost", "browser-token", {"x-tli-peer-id": "peer"}, False),
    ("127.0.0.1", "localhost", "browser-token", {"sec-fetch-site": "cross-site"}, False),
    ("127.0.0.1", "localhost", "browser-token", {"origin": "https://evil.example"}, False),
])
def test_browser_authority_requires_real_local_or_authenticated_same_origin_browser(pair, monkeypatch, host, hostname, token, headers, allowed):
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": False})
    req = request(host, hostname=hostname, token=token, headers=headers)
    if allowed: assert Q.browser_owner(req) in ("local", "owner")
    else:
        with pytest.raises(HTTPException) as error: Q.browser_owner(req)
        assert error.value.status_code == 403


def test_locked_pin_session_uses_401_but_open_lan_pairing_denial_does_not_lock_app(pair, monkeypatch):
    req = request("192.168.2.20", hostname="192.168.2.10", token=None)
    with pytest.raises(HTTPException) as error: Q.browser_owner(req)
    assert error.value.status_code == 401
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": False})
    with pytest.raises(HTTPException) as error: Q.browser_owner(req)
    assert error.value.status_code == 403
    assert "localhost" in error.value.detail["message"]


@pytest.mark.parametrize("change", ["http", "other_ip", "cookie", "bearer"])
def test_peer_bootstrap_source_requires_https_exact_private_ip_no_credentials(pair, change):
    init = {"request_id": "a" * 48, "target_id": pair.a.card["node_id"], "target_origin": pair.a.card["origin"],
            "card": pair.b.card, "sent_at": int(time.time())}
    init["commitment"] = Q._commit(init, "b" * 64)
    init = sign(pair.b.key, "request", **init)
    req = request("192.168.2.30" if change == "other_ip" else "192.168.2.20", hostname="192.168.2.10",
                  scheme="http" if change == "http" else "https", token="browser-token" if change == "cookie" else None,
                  headers={"authorization": "Bearer anything"} if change == "bearer" else {})
    before = pair.a.directory_path.read_bytes()
    with pytest.raises(HTTPException): Q.receive(init, req)
    assert pair.a.directory_path.read_bytes() == before


def test_route_body_limit_and_strict_consent(pair):
    app = FastAPI()
    app.include_router(peer_pairing_routes.router)
    with TestClient(app, base_url="https://localhost", client=("127.0.0.1", 12345)) as client:
        client.cookies.set("tli_session", "browser-token")
        result = client.get("/mesh/pairing/requests")
        assert result.status_code == 200 and result.headers["cache-control"] == "no-store"
        assert client.post("/agent/pairing/request", content=b"x" * (Q.MAX_BODY + 1), headers={"Content-Type": "application/json"}).status_code == 413
        assert client.post("/mesh/pairing/missing/confirm", json={"code": "AAAA-BBBB-CCCC", "allow_messages": "true"}).status_code == 422
        assert client.post("/mesh/pairing/start", json={"device_id": "anything", "grants": ["inference"]}).status_code == 422


def test_full_host_mounts_pairing_routes_with_no_store_and_browser_gate(pair):
    from main import app
    with TestClient(app, base_url="https://localhost", client=("127.0.0.1", 12345)) as client:
        client.cookies.set("tli_session", "browser-token")
        result = client.get("/mesh/pairing/requests")
        assert result.status_code == 200, result.text
        assert result.json() == {"ok": True, "supported": True, "protocols": [Q.PROTOCOL, Q.PROTOCOL_V2], "requests": []}
        assert result.headers["cache-control"] == "no-store"
        client.cookies.clear()
        assert client.get("/mesh/pairing/requests").status_code == 401
        assert client.post("/agent/pairing/request", json={}).status_code == 422


def test_rate_and_pending_memory_are_bounded(pair):
    for index in range(6): Q._rate(("test", "source"), 6)
    with pytest.raises(HTTPException): Q._rate(("test", "source"), 6)
    Q._RATES.clear()
    Q._GLOBAL_RATE.clear()
    for index in range(64): Q._rate(("source", index), 6)
    with pytest.raises(HTTPException): Q._rate(("source", "new"), 6)
    assert len(Q._RATES) == 64


def test_original_local_owner_session_cannot_fall_back_after_pin_is_removed(pair, monkeypatch):
    monkeypatch.setattr(S, "get_session_user_id", lambda token: "local")
    outgoing = Q.start(pair.b.card["node_id"], None, "local", request())["request"]
    monkeypatch.setattr(S, "validate_session_token", lambda token: False)
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": False})
    assert Q.browser_owner(request()) == "local"
    with pytest.raises(HTTPException):
        Q.confirm(outgoing["request_id"], outgoing["code"], True, "local", request())
    assert not S.load_mesh_directory()[pair.b.card["node_id"]].get("peer_trust")


def test_peer_status_replay_cannot_restore_old_confirmation(pair):
    outgoing = begin(pair)
    Q.refresh(outgoing["request_id"], "owner", request())
    poll = pair.calls[-1][2]
    with pair.active("b"):
        req = request("192.168.2.10", token=None, hostname="192.168.2.20")
        with pytest.raises(HTTPException) as error:
            Q.status(poll, req)
        assert error.value.detail["code"] == "pairing_replayed"


def test_original_confirmation_does_not_override_later_revocation(pair):
    outgoing = begin(pair)
    Q.confirm(outgoing["request_id"], outgoing["code"], True, "owner", request())
    directory = S.load_mesh_directory()
    directory[pair.b.card["node_id"]]["status"] = "blocked"
    S.save_mesh_directory(directory)
    assert Q.requests("owner", request())["requests"][0]["local_confirmed"] is False
    with pytest.raises(HTTPException): Q.confirm(outgoing["request_id"], outgoing["code"], True, "owner", request())
    assert S.load_mesh_directory()[pair.b.card["node_id"]]["status"] == "blocked"


@pytest.mark.parametrize("mode", ["bootstrap", "pinned", "wrong_pin", "redirect", "oversized", "old_version"])
def test_transport_binds_adapter_pins_before_bytes_and_rejects_unbounded_or_redirected_responses(pair, monkeypatch, mode):
    # Recover just the implementation after conftest globally disables all peer
    # transports. Every socket-like object below is synthetic.
    import ast
    import hashlib
    from pathlib import Path
    source = ast.parse(Path(Q.__file__).read_text(encoding="utf-8"))
    function = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == "_exchange")
    namespace = dict(Q.__dict__)
    exec(compile(ast.Module(body=[function], type_ignores=[]), Q.__file__, "exec"), namespace)
    exchange = namespace["_exchange"]
    operations = []
    leaf = b"synthetic certificate"
    fingerprint = hashlib.sha256(leaf).hexdigest()

    class Socket:
        def getpeercert(self, binary_form=False): return leaf
        def shutdown(self, how): operations.append("shutdown")

    class Connection:
        def __init__(self, host, port, **kwargs):
            assert host == "192.168.2.20" and port == 8443
            assert kwargs["source_address"] == ("192.168.2.10", 0)
            assert kwargs["timeout"] == 4
            self.sock = Socket()
        def connect(self): operations.append("connect")
        def request(self, method, path, body, headers):
            operations.append("send")
            assert method == "POST" and path == "/agent/pairing/request"
            assert set(headers) == {"Content-Type", "Accept"}
            assert json.loads(body) == {"public": "only"}
        def getresponse(self):
            status = 302 if mode == "redirect" else 404 if mode == "old_version" else 200
            def read(bound):
                assert bound == Q.MAX_BODY + 1
                return b"x" * bound if mode == "oversized" else b'{"ok":true}'
            return NS(status=status, read=read)
        def close(self): operations.append("close")

    class Timer:
        def __init__(self, seconds, callback): assert seconds == 6
        def start(self): operations.append("timer")
        def cancel(self): operations.append("cancel-timer")

    monkeypatch.setattr(Q.http.client, "HTTPSConnection", Connection)
    monkeypatch.setattr(Q.threading, "Timer", Timer)
    pin = None if mode == "bootstrap" else "0" * 64 if mode == "wrong_pin" else fingerprint
    kwargs = {"pin": pin, "source_origin": pair.a.card["origin"]}
    if mode in ("bootstrap", "pinned"):
        assert exchange(pair.b.card["origin"], "/agent/pairing/request", {"public": "only"}, **kwargs) == ({"ok": True}, fingerprint)
    else:
        with pytest.raises(HTTPException): exchange(pair.b.card["origin"], "/agent/pairing/request", {"public": "only"}, **kwargs)
    assert ("send" in operations) is (mode != "wrong_pin")
    assert operations[-1] == "close"
