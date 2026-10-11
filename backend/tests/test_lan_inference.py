"""Synthetic keys and bounded fake streams; never use LAN devices or real models."""
import copy
import io
import json
from contextlib import contextmanager
from types import SimpleNamespace as NS

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import lan_inference as L
import peer_trust as P
import tli_state as S
from routers import lan_inference_routes as routes
from tests.test_peer_trust import peers, signed


def authorize(peers):
    directory = S.load_mesh_directory()
    directory["peer-b"]["peer_trust"]["grants"].append("inference")
    S.save_mesh_directory(directory)
    return {"device_id": "peer-b", "revision": P.trusted("peer-b", "inference")[2], "grant": "inference"}


def resource():
    return {"id": L._resource_id("lmstudio", "local-model"), "revision": "c" * 64,
            "provider": "lmstudio", "model_id": "local-model", "label": "Local model", "context_window": 8192,
            "_upstream_model": "local-model", "_model_key": "local-model",
            "_binding": {"url": "http://127.0.0.1:1234/v1/chat/completions", "catalog_url": "http://127.0.0.1:1234/api/v1/models"}}


def payload(row=None):
    row = row or resource()
    return {"protocol": L.PROTOCOL, "resource_id": row["id"], "resource_revision": row["revision"],
            "messages": [{"role": "system", "content": "TLI prepared private context"}, {"role": "user", "content": "Hello"}],
            "max_tokens": 512, "temperature": .2}


def selected(peers):
    return L.selection({"peer_id": "peer-b", "trust_revision": P.trusted("peer-b", "inference")[2],
                        "resource_id": resource()["id"], "resource_revision": resource()["revision"]})


def meta(peers):
    row = resource()
    return {"type": "meta", "protocol": L.PROTOCOL, "peer": {"id": "peer-b", "name": peers.b["name"]},
            "identity_fingerprint": peers.b["identity_fingerprint"], "resource_id": row["id"], "resource_revision": row["revision"],
            "provider": row["provider"], "model": row["model_id"]}


def lines(events):
    for event in events:
        yield ("data: " + (event if isinstance(event, str) else json.dumps(event)) + "\n").encode()
        yield b"\n"


def chunk(text=None, finish=None):
    return {"model": "local-model", "choices": [{"delta": {"content": text}, "finish_reason": finish}]}


def install_worker(monkeypatch, *, events=None):
    row = resource()
    monkeypatch.setattr(L, "_resources", lambda **kw: [row])
    monkeypatch.setattr(L, "_lm_binding", lambda: row["_binding"])
    monkeypatch.setattr(L, "_revalidate_loaded", lambda resource, check: check())
    observed = []
    @contextmanager
    def response(url, method="GET", body=None, **kwargs):
        kwargs.get("check", lambda: None)()
        kwargs.get("before_send", lambda: None)()
        observed.append((url, method, copy.deepcopy(body)))
        stream = io.BytesIO(b"".join(lines(events if events is not None else [chunk("Hello"), chunk(finish="stop"), "[DONE]"])))
        stream.getheader = lambda *args: "text/event-stream"
        yield stream
    monkeypatch.setattr(L, "_local_response", response)
    return row, observed


def test_existing_grants_never_authorize_inference_and_peer_listing_never_probes(peers, monkeypatch):
    monkeypatch.setattr(L, "_resources", lambda **kw: pytest.fail("Listing probed local model"))
    monkeypatch.setattr(P, "_exchange", lambda *a: pytest.fail("Listing probed LAN"))
    before = S.MESH_DIRECTORY_PATH.read_bytes()
    assert L.peers() == {"protocol": L.PROTOCOL, "peers": []}
    with pytest.raises(HTTPException) as error:
        selected(peers)
    assert error.value.status_code == 403
    assert S.MESH_DIRECTORY_PATH.read_bytes() == before
    authorize(peers)
    assert L.peers()["peers"] == [{"id": "peer-b", "name": peers.b["name"]}]
    assert P.validate_card(peers.b) == peers.b


def test_inference_grant_requires_fresh_explicit_review_without_mutating_card(peers):
    from tests.test_peer_trust import browser
    review = P.preview(peers.b, ["observe", "inference"], "owner", browser())
    assert "inference" not in P.trusted("peer-b")[0]["peer_trust"]["grants"]
    P.approve(review["review_id"], peers.b["identity_fingerprint"], peers.b["certificate_sha256"], "owner", browser())
    assert P.trusted("peer-b", "inference")[1] == peers.b


@pytest.mark.parametrize("mode", ["unsigned", "cookie", "wrong_grant", "http", "tampered"])
def test_worker_rejects_unreviewed_requests_before_model_io(peers, monkeypatch, mode):
    app = FastAPI(); app.include_router(routes.router)
    monkeypatch.setattr(L, "_resources", lambda **kw: pytest.fail("Denied request used model"))
    if mode != "wrong_grant":
        authorize(peers)
    raw, headers = signed(peers, "/agent/peer/inference/stream", payload())
    if mode == "unsigned": headers = {}
    if mode == "cookie": headers = {"cookie": "tli_session=browser-token"}
    if mode == "tampered": raw = raw.replace(b"Hello", b"Wrong")
    base = "http://192.168.2.10:8443" if mode == "http" else "https://192.168.2.10:8443"
    with TestClient(app, base_url=base) as client:
        response = client.post("/agent/peer/inference/stream", content=raw, headers=headers)
        assert response.status_code in (401, 403), response.text


def test_signed_worker_stream_preserves_prepared_messages_and_rejects_replay(peers, monkeypatch):
    authorize(peers)
    _, calls = install_worker(monkeypatch)
    app = FastAPI(); app.include_router(routes.router)
    request_body = payload()
    raw, headers = signed(peers, "/agent/peer/inference/stream", request_body)
    before = S.MESH_DIRECTORY_PATH.read_bytes()
    with TestClient(app, base_url="https://192.168.2.10:8443") as client:
        response = client.post("/agent/peer/inference/stream", content=raw, headers=headers)
        assert response.status_code == 200, response.text
        result = [json.loads(value) for value in L._events(iter(response.content.splitlines(keepends=True)))]
        assert [e["type"] for e in result] == ["meta", "delta", "done"]
        assert result[0]["peer"]["id"] == "local-a"
        assert result[1]["text"] == "Hello"
        assert calls[0][2]["messages"] == request_body["messages"]
        assert set(calls[0][2]) == {"model", "messages", "max_tokens", "temperature", "stream"}
        assert client.post("/agent/peer/inference/stream", content=raw, headers=headers).status_code == 409
    assert S.MESH_DIRECTORY_PATH.read_bytes() == before
    assert not L._SLOT.locked()


@pytest.mark.parametrize("change", ["role", "image", "tool", "extra", "tokens", "temperature", "too_large"])
def test_worker_rejects_nontext_or_unbounded_contract(peers, monkeypatch, change):
    access = authorize(peers)
    body = payload()
    if change == "role": body["messages"][0]["role"] = "tool"
    if change == "image": body["messages"][0]["content"] = [{"type": "image_url", "image_url": "private"}]
    if change == "tool": body["messages"][0]["tools"] = []
    if change == "extra": body["command"] = "echo bad"
    if change == "tokens": body["max_tokens"] = 2049
    if change == "temperature": body["temperature"] = float("nan")
    if change == "too_large": body["messages"][0]["content"] = "x" * P.MAX_BODY
    monkeypatch.setattr(L, "_resources", lambda **kw: pytest.fail("Invalid input used models"))
    with pytest.raises(HTTPException): list(L.worker_stream(body, access))
    assert not L._SLOT.locked()


def test_unsigned_oversize_body_is_bounded_before_json_parsing(peers):
    app = FastAPI(); app.include_router(routes.router)
    with TestClient(app) as client:
        response = client.post("/agent/peer/inference/stream", content=b"x" * (P.MAX_BODY + 1))
    assert response.status_code == 413


def test_model_catalog_only_advertises_loaded_local_instances(monkeypatch):
    from ai.ai_manager import BundledAIManager
    mgr = NS(base_url="http://127.0.0.1:9999", active_preset_id="lite", cfg=NS(model_path="synthetic.gguf"),
             text_capacity=lambda: {"status": "unknown"}, _transition=False, is_healthy=lambda: False)
    monkeypatch.setattr(BundledAIManager, "get", lambda: mgr)
    monkeypatch.setattr(S, "lm_provider", NS(chat_url="http://localhost:1234/v1/chat/completions", models_url="http://localhost:1234/v1/models"))
    catalogs = []
    def catalog(url, **kwargs):
        catalogs.append(url)
        return {"models": [
            {"type": "llm", "key": "loaded", "display_name": "Loaded", "loaded_instances": [{"id": "instance", "config": {"context_length": 4096}}]},
            {"type": "llm", "key": "downloaded", "loaded_instances": []},
            {"type": "embedding", "key": "embed", "loaded_instances": [{"id": "embedding", "config": {}}]},
        ]}
    monkeypatch.setattr(L, "_local_json", catalog)
    result = L._resources()
    assert [row["model_id"] for row in result] == ["instance"]
    assert result[0]["context_window"] == 4096
    assert catalogs == ["http://127.0.0.1:1234/api/v1/models"]


@pytest.mark.parametrize("url", ["http://192.168.1.5:1234/v1/chat/completions", "http://example.test/v1/chat/completions", "http://user@127.0.0.1/v1/chat/completions", "http://127.0.0.1/v1/chat/completions?secret=x"])
def test_remote_proxy_or_credential_endpoints_refused(url):
    with pytest.raises(HTTPException): L._local_url(url, "/v1/chat/completions")


def test_worker_context_resource_change_and_busy_checks_precede_generation(peers, monkeypatch):
    access = authorize(peers)
    row, calls = install_worker(monkeypatch)
    body = payload()
    body["resource_revision"] = "b" * 64
    with pytest.raises(HTTPException) as error: list(L.worker_stream(body, access))
    assert error.value.status_code == 409 and not calls
    row["context_window"] = 32
    with pytest.raises(HTTPException) as error: list(L.worker_stream(payload(), access))
    assert error.value.status_code == 422 and not calls
    with L._SLOT:
        with pytest.raises(HTTPException) as error: list(L.worker_stream(payload(), access))
        assert error.value.status_code == 429
    assert not L._SLOT.locked()


@pytest.mark.parametrize("events", [[chunk("partial")], [chunk("partial"), "[DONE]"], [chunk("partial"), chunk(finish="stop")], [{"model": "wrong", "choices": []}], [chunk("x" * (L.MAX_LINE + 1))]])
def test_worker_never_reports_done_on_invalid_or_interrupted_output(peers, monkeypatch, events):
    access = authorize(peers)
    install_worker(monkeypatch, events=events)
    received = []
    with pytest.raises(HTTPException):
        for event in L.worker_stream(payload(), access): received.append(event)
    assert not any(event["type"] == "done" for event in received)
    assert not L._SLOT.locked()


def test_worker_revocation_stops_before_next_content_and_releases_slot(peers, monkeypatch):
    access = authorize(peers)
    install_worker(monkeypatch)
    stream = L.worker_stream(payload(), access)
    assert next(stream)["type"] == "meta"
    from routers.mesh_routes import mesh_trust_revoke
    mesh_trust_revoke("peer-b")
    with pytest.raises(HTTPException): next(stream)
    assert not L._SLOT.locked()


def test_sender_stream_validates_identity_and_keeps_prepared_context(peers, monkeypatch):
    authorize(peers)
    captured = []
    def exchange(card, method, path, body, headers, check):
        check(); captured.append(json.loads(body))
        return lines([meta(peers), {"type": "delta", "text": "Answer"}, {"type": "done"}])
    monkeypatch.setattr(P, "_stream_exchange", exchange)
    messages = payload()["messages"]
    result = list(L.stream(selected(peers), messages, max_tokens=512, temperature=.2, check=lambda: None))
    assert result[1] == {"type": "delta", "text": "Answer"}
    assert captured[0]["messages"] == messages
    assert result[-1] == {"type": "done"}


@pytest.mark.parametrize("mode", ["wrong_peer", "wrong_model", "wrong_revision", "premature_delta", "incomplete", "invalid_json", "oversize", "revoked"])
def test_sender_discards_unverified_or_incomplete_peer_output(peers, monkeypatch, mode):
    authorize(peers)
    head = meta(peers)
    events = [head, {"type": "delta", "text": "Answer"}, {"type": "done"}]
    if mode == "wrong_peer": head["peer"] = {"id": "other", "name": "Other"}
    if mode == "wrong_model": head["model"] = "different"
    if mode == "wrong_revision": head["resource_revision"] = "d" * 64
    if mode == "premature_delta": events = events[1:]
    if mode == "incomplete": events = events[:-1]
    if mode == "invalid_json": events = ["{no"]
    if mode == "oversize": events[1]["text"] = "x" * L.MAX_LINE
    def exchange(*args):
        for event in events:
            if mode == "revoked" and event.get("type") == "delta":
                from routers.mesh_routes import mesh_trust_revoke
                mesh_trust_revoke("peer-b")
            yield from lines([event])
    monkeypatch.setattr(P, "_stream_exchange", exchange)
    result = []
    with pytest.raises(HTTPException):
        for event in L.stream(selected(peers), payload()["messages"], max_tokens=512, temperature=.2, check=lambda: None): result.append(event)
    assert not any(event["type"] == "done" for event in result)
    if mode != "incomplete": assert not any(event["type"] == "delta" for event in result)


def test_capability_response_must_match_reviewed_peer_and_resource_hash(peers, monkeypatch):
    authorize(peers)
    value = {"protocol": L.PROTOCOL, "peer": {"id": "peer-b", "name": peers.b["name"]}, "identity_fingerprint": peers.b["identity_fingerprint"],
             "resources": [L._public_resource(resource())], "checked_at": S.now_iso()}
    monkeypatch.setattr(P, "_exchange", lambda *a: P.Response(200, P.canonical(value)))
    assert L.models("peer-b")["resources"][0]["model_id"] == "local-model"
    value["resources"][0]["id"] = "f" * 64
    with pytest.raises(HTTPException): L.models("peer-b")


def test_old_peer_404_is_explicit_unsupported_not_fallback(peers, monkeypatch):
    authorize(peers)
    monkeypatch.setattr(P, "_exchange", lambda *a: P.Response(404, b"{}"))
    with pytest.raises(HTTPException) as error: L.models("peer-b")
    assert error.value.status_code == 409 and error.value.detail["code"] == "peer_inference_unsupported"


@pytest.mark.parametrize("failure_at", ["http.response.start", "http.response.body"])
def test_asgi_disconnect_releases_primed_worker_without_gc(peers, monkeypatch, failure_at):
    import asyncio
    from starlette.requests import ClientDisconnect
    access = authorize(peers)
    install_worker(monkeypatch)
    response = routes.inference(payload(), access)
    assert L._SLOT.locked()  # admission is deliberately primed before HTTP 200
    async def receive():
        return {"type": "http.disconnect"}
    async def send(message):
        if message["type"] == failure_at:
            raise OSError("synthetic browser disconnected")
    async def run():
        with pytest.raises(ClientDisconnect):
            await response({"asgi": {"spec_version": "2.4"}}, receive, send)
        assert not L._SLOT.locked()
    asyncio.run(run())
    # No explicit aclose, gc.collect or test fixture cleanup may be required.
    assert not L._SLOT.locked()


def test_worker_generator_close_releases_slot(peers, monkeypatch):
    access = authorize(peers)
    install_worker(monkeypatch)
    events = L.worker_stream(payload(), access)
    assert next(events)["type"] == "meta"
    events.close()
    assert not L._SLOT.locked()


def test_receiver_and_sender_enforce_aggregate_answer_limit(peers, monkeypatch):
    access = authorize(peers)
    content = "x" * 8192
    install_worker(monkeypatch, events=[chunk(content)] * 17 + [chunk(finish="stop"), "[DONE]"])
    with pytest.raises(HTTPException) as error:
        list(L.worker_stream(payload(), access))
    assert error.value.detail["code"] == "inference_output_limit" and not L._SLOT.locked()
    events = [meta(peers)] + [{"type": "delta", "text": content}] * 17 + [{"type": "done"}]
    monkeypatch.setattr(P, "_stream_exchange", lambda *args: lines(events))
    with pytest.raises(HTTPException) as error:
        list(L.stream(selected(peers), payload()["messages"], max_tokens=512, temperature=.2))
    assert error.value.detail["code"] == "inference_output_limit"


@pytest.mark.parametrize("mode", ["unowned", "dead", "changed_endpoint", "owned"])
def test_bundled_resources_require_owned_live_launch_not_just_health(monkeypatch, mode):
    from ai.ai_manager import BundledAIManager
    process = NS(pid=12345, poll=lambda: None, args=["llama-server", "--model", "owned.gguf", "--host", "127.0.0.1", "--port", "9999"])
    manager = NS(base_url="http://127.0.0.1:9999", active_preset_id="lite", _proc=process, _transition=False,
                 cfg=NS(model_path="owned.gguf", host="127.0.0.1", port=9999, health_path="/v1/models"),
                 text_capacity=lambda: {"status": "configured", "source": "owned_runtime_launch", "model": "lite", "context_tokens": 4096},
                 is_healthy=lambda: pytest.fail("Health must use bounded proxy-free loopback transport"))
    if mode == "unowned": manager._proc = None
    if mode == "dead": process.poll = lambda: 1
    if mode == "changed_endpoint": manager.cfg.port = 1111
    monkeypatch.setattr(BundledAIManager, "get", lambda: manager)
    monkeypatch.setattr(S, "lm_provider", NS(chat_url="http://remote.example/v1/chat/completions", models_url="http://remote.example/v1/models"))
    observed = []
    monkeypatch.setattr(L, "_local_json", lambda url, **kwargs: observed.append(url) or {"data": []})
    rows = L._resources()
    assert bool(rows) is (mode == "owned")
    assert observed == (["http://127.0.0.1:9999/v1/models"] if mode == "owned" else [])


def test_lmstudio_rechecks_exact_loaded_instance_configuration_before_post(monkeypatch):
    row = resource()
    config = {"context_length": 8192}
    row["revision"] = P.digest({**row["_binding"], "key": "local-model", "instance": "local-model", "config": config})
    value = {"models": [{"type": "llm", "key": "local-model", "loaded_instances": [{"id": "local-model", "config": config}]}]}
    monkeypatch.setattr(L, "_local_json", lambda *a, **kw: copy.deepcopy(value))
    L._revalidate_loaded(row, lambda: None)
    config["context_length"] = 4096
    with pytest.raises(HTTPException) as error: L._revalidate_loaded(row, lambda: None)
    assert error.value.status_code == 409
    value["models"][0]["loaded_instances"] = []
    with pytest.raises(HTTPException): L._revalidate_loaded(row, lambda: None)


def production_stream_exchange(connection=None):
    import ast
    from pathlib import Path
    tree = ast.parse(Path(P.__file__).read_text(encoding="utf-8"))
    function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "_stream_exchange")
    namespace = dict(vars(P))
    if connection is not None:
        namespace["http"] = NS(client=NS(HTTPSConnection=connection))
    exec(compile(ast.Module(body=[function], type_ignores=[]), P.__file__, "exec"), namespace)
    return namespace["_stream_exchange"]


@pytest.mark.parametrize("mode", ["wrong_pin", "redirect", "wrong_type", "oversize", "timeout", "valid"])
def test_signed_stream_transport_pins_before_prompt_and_bounds_response(peers, monkeypatch, mode):
    import base64
    import socket
    raw_cert = base64.b64decode(peers.b["certificate_der"])
    sent, closed, deadlines = [], [], []
    class Timer:
        def __init__(self, seconds, callback): deadlines.append(seconds)
        def start(self): pass
        def cancel(self): pass
    class Socket:
        def getpeercert(self, **kw): return b"wrong" if mode == "wrong_pin" else raw_cert
        def settimeout(self, value): assert 0 < value <= 90
    class Response:
        status = 302 if mode == "redirect" else 200
        def __init__(self): self.lines = iter([b"x" * (L.MAX_LINE + 1)] if mode == "oversize" else [b"data: x\n", b"\n"])
        def getheader(self, *args): return "application/json" if mode == "wrong_type" else "text/event-stream"
        def readline(self, amount):
            if mode == "timeout": raise socket.timeout()
            return next(self.lines, b"")
    class Connection:
        def __init__(self, *args, **kwargs): self.sock = Socket()
        def connect(self): pass
        def request(self, *args, **kwargs): sent.append((args, kwargs))
        def getresponse(self): return Response()
        def close(self): closed.append(True)
    monkeypatch.setattr(P.http.client, "HTTPSConnection", Connection)
    monkeypatch.setattr(P.threading, "Timer", Timer)
    exchange = production_stream_exchange()
    call = lambda: list(exchange(peers.b, "POST", "/agent/peer/inference/stream", b'"private prompt"', {"X-TLI-Peer-Signature": "private-signature"}, lambda: None))
    if mode == "valid": assert call() == [b"data: x\n", b"\n"]
    else:
        with pytest.raises(HTTPException): call()
    assert closed == [True]
    assert bool(sent) is (mode != "wrong_pin")
    if deadlines: assert 0 < deadlines[0] <= 120


def test_real_owned_loopback_tls_delivers_first_event_before_completion(peers, monkeypatch):
    """Real TLS and signatures, remapped only to a disposable local listener."""
    import http.client
    import http.server
    import socket
    import ssl
    import threading
    from cryptography.hazmat.primitives import serialization
    authorize(peers)
    cert_path, key_path = peers.root / "inference-cert.pem", peers.root / "inference-key.pem"
    cert_path.write_bytes(P._certificate(peers.b).public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(peers.key_b.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    release, received = threading.Event(), []
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            signature = P._signed("POST", self.path, body, {"node_id": "peer-b", "public_key": peers.b["public_key"]},
                                  self.headers["X-TLI-Peer-Time"], self.headers["X-TLI-Peer-Nonce"], peers.a["node_id"])
            peers.key_a.public_key().verify(bytes.fromhex(self.headers["X-TLI-Peer-Signature"]), signature)
            received.append(json.loads(body))
            self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.end_headers()
            self.wfile.write(b"".join(lines([meta(peers), {"type": "delta", "text": "First token"}]))); self.wfile.flush()
            assert release.wait(5), "Client buffered the first event until completion"
            self.wfile.write(b"".join(lines([{"type": "done"}]))); self.wfile.flush()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); context.load_cert_chain(cert_path, key_path)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    original = http.client.HTTPSConnection
    class LoopbackOnlyConnection(original):
        def connect(self):
            assert self.host == "192.168.2.20" and self.port == 8443
            self.sock = self._context.wrap_socket(socket.create_connection(("127.0.0.1", server.server_port), timeout=3), server_hostname=self.host)
    monkeypatch.setattr(P, "_stream_exchange", production_stream_exchange(LoopbackOnlyConnection))
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    events = L.stream(selected(peers), payload()["messages"], max_tokens=512, temperature=.2, check=lambda: None)
    try:
        assert next(events)["type"] == "meta"
        assert next(events) == {"type": "delta", "text": "First token"}
        assert not release.is_set()
        release.set()
        assert next(events) == {"type": "done"}
        assert list(events) == []
        assert received[0]["messages"] == payload()["messages"]
    finally:
        release.set(); events.close(); server.shutdown(); server.server_close(); thread.join(3)
    assert not thread.is_alive()
