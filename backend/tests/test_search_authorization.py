"""Private SearXNG proxy boundaries with real browser checks and fake HTTP only."""
import json
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest
import requests

import tli_state as S
from routers import search_routes as search


PRIVATE_QUERY = "private household research"
RESULT = {"url": "https://result.example.test/page?q=one#section", "title": "Private result", "content": "Private snippet"}


@pytest.fixture
def proxy(monkeypatch, tmp_path):
    monkeypatch.setattr(S, "DATA_DIR", tmp_path)
    monkeypatch.setattr(S, "_active_sessions", {})
    pin = {"enabled": False}
    monkeypatch.setattr(S, "load_pin_config", lambda: dict(pin))
    logs = Mock(); monkeypatch.setattr(S, "log_debug", logs)
    hooks, chunks, phases, sessions = {}, [json.dumps({"results": [RESULT]}).encode()], [], []
    def at(phase):
        phases.append(phase)
        if phase in hooks: hooks[phase]()
    class Upstream:
        status_code = 200
        def raise_for_status(self):
            at("status")
            if self.status_code >= 400:
                raise requests.HTTPError("PRIVATE QUERY URL AND UPSTREAM FAILURE")
        def iter_content(self, *, chunk_size):
            assert chunk_size == 64 * 1024
            at("read-start")
            for index, chunk in enumerate(chunks):
                at("chunk-" + str(index))
                yield chunk
            at("read-end")
        def close(self):
            at("response-close")
    upstream = Upstream()
    get = Mock(side_effect=lambda *args, **kwargs: (at("get"), upstream)[1])
    class Session:
        def __init__(self):
            self.trust_env = True; sessions.append(self); at("session-create")
        def __enter__(self):
            at("session-enter"); return self
        def __exit__(self, *args):
            at("session-close")
        def get(self, *args, **kwargs):
            assert self.trust_env is False
            return get(*args, **kwargs)
    factory = Mock(side_effect=Session)
    monkeypatch.setattr(search.requests, "Session", factory)
    app = FastAPI(); app.include_router(search.router)
    clients = []
    def browser(*, pin_on=False, remote=False, secure=False, cookie=False):
        pin["enabled"] = pin_on
        base = ("https" if secure else "http") + "://" + ("host.example.test:8443" if remote else "localhost:8000")
        client = TestClient(app, base_url=base, client=("192.0.2.10" if remote else "127.0.0.1", 1234),
                            headers={"Sec-Fetch-Site": "same-origin"})
        token = S.create_session_token("owner") if cookie else None
        if token: client.headers["Cookie"] = "tli_session=" + token
        clients.append(client)
        return client, token
    yield SimpleNamespace(browser=browser, pin=pin, hooks=hooks, phases=phases, chunks=chunks,
                          upstream=upstream, get=get, factory=factory, logs=logs, sessions=sessions)
    for client in clients: client.close()
    logs.assert_not_called()


def query(client, **params):
    return client.get("/search/query", params={"q": PRIVATE_QUERY, **params})


@pytest.mark.parametrize("mode", ["anonymous-pin", "stale-cookie", "expired-cookie", "pin-off-lan", "pin-off-lan-cookie",
    "remote-http", "bearer", "bearer-cookie", "peer", "proxy", "rebound-host", "cross-origin", "null-origin",
    "same-site", "cross-site", "duplicate-origin", "duplicate-host"])
def test_denial_precedes_validation_and_outbound_http(proxy, monkeypatch, mode):
    remote = mode in {"pin-off-lan", "pin-off-lan-cookie", "remote-http"}
    cookie = mode not in {"anonymous-pin", "pin-off-lan", "bearer"}
    pin_on = mode not in {"stale-cookie", "pin-off-lan", "pin-off-lan-cookie", "rebound-host"}
    client, token = proxy.browser(pin_on=pin_on, remote=remote, secure=remote and mode != "remote-http", cookie=cookie)
    if mode == "stale-cookie": S.revoke_session_token(token)
    if mode == "expired-cookie": S._active_sessions[token]["expiry"] = 0
    if mode.startswith("bearer"): client.headers["Authorization"] = "Bearer invalid-native-token"
    if mode == "peer": client.headers["X-TLI-Peer-Signature"] = "private-peer-proof"
    if mode == "proxy": client.headers["X-Forwarded-Host"] = "localhost"
    if mode == "rebound-host": client.headers["Host"] = "rebound.example.test"
    if mode == "cross-origin": client.headers["Origin"] = "https://elsewhere.example.test"
    if mode == "null-origin": client.headers["Origin"] = "null"
    if mode in {"same-site", "cross-site"}: client.headers["Sec-Fetch-Site"] = mode
    if mode == "duplicate-origin": client.headers.update([("Origin", "http://localhost:8000"), ("Origin", "http://localhost:8000")])
    if mode == "duplicate-host": client.headers.update([("Host", "localhost:8000"), ("Host", "localhost:8000")])
    validate = Mock(side_effect=AssertionError("Validation must follow authority"))
    monkeypatch.setattr(search, "_validate_endpoint", validate)
    result = query(client)
    assert result.status_code == (401 if mode in {"anonymous-pin", "stale-cookie", "expired-cookie"} else 403), result.text
    assert result.headers["cache-control"] == "no-store"
    proxy.factory.assert_not_called(); proxy.get.assert_not_called(); validate.assert_not_called()


@pytest.mark.parametrize("mode", ["open-local", "pin-local", "pin-https"])
@pytest.mark.parametrize("endpoint", ["http://localhost:8080", "http://127.0.0.1:8080/", "http://192.0.2.20:8080/searxng/",
                                      "https://search.example.test/base/path", "http://[::1]:8080"])
def test_supported_browser_and_explicit_destination_contracts(proxy, mode, endpoint):
    client, _ = proxy.browser(pin_on=mode != "open-local", remote=mode == "pin-https", secure=mode == "pin-https", cookie=mode != "open-local")
    result = query(client, endpoint=endpoint, k=3)
    assert result.status_code == 200, result.text
    assert result.headers["cache-control"] == "no-store"
    assert result.json() == {"results": [{"url": RESULT["url"], "title": RESULT["title"], "snippet": RESULT["content"]}],
                             "ms": result.json()["ms"], "endpoint": endpoint.rstrip("/")}
    assert isinstance(result.json()["ms"], int)
    proxy.get.assert_called_once_with(endpoint.rstrip("/") + "/search",
        params={"q": PRIVATE_QUERY, "format": "json", "language": "en-US", "safesearch": "1"},
        timeout=(3.0, 8.0), headers={"Accept": "application/json"}, stream=True, allow_redirects=False)
    assert proxy.phases.count("response-close") == 1 and proxy.phases.count("session-close") == 1


@pytest.mark.parametrize("endpoint", ["", "ftp://localhost", "file:///private/path", "//localhost:8080", "http://",
    "http://user:secret@localhost:8080", "https://search.example.test?token=private", "https://search.example.test#fragment",
    "https://search.example.test?", "https://search.example.test#", "http://localhost:0", "http://localhost:65536",
    "http://localhost:port", "http://[::1", "http://localhost\\private", "http://local host", "\nhttp://localhost",
    "http://localhost/\r\nX-Header: secret"])
def test_invalid_endpoint_never_creates_outbound_session(proxy, endpoint):
    client, _ = proxy.browser()
    result = query(client, endpoint=endpoint)
    assert result.status_code == 400, result.text
    assert result.headers["cache-control"] == "no-store"
    proxy.factory.assert_not_called()


@pytest.mark.parametrize("params", [{"q": "private" * 100}, {"k": 0}, {"k": 11}, {"endpoint": "https://" + "private" * 500}])
def test_validation_error_does_not_echo_or_cache_private_input(proxy, params):
    client, _ = proxy.browser()
    result = query(client, **params)
    assert result.status_code == 422
    assert result.headers["cache-control"] == "no-store"
    assert "private" not in result.text
    proxy.factory.assert_not_called()


@pytest.mark.parametrize("phase", ["endpoint", "session-enter", "get", "status", "chunk-0", "read-end", "decode", "response-close", "session-close", "format"])
@pytest.mark.parametrize("failed", [False, True])
def test_revocation_at_each_slow_boundary_prevents_output_and_further_network(proxy, monkeypatch, phase, failed):
    client, token = proxy.browser(pin_on=True, cookie=True)
    def revoke():
        S.revoke_session_token(token)
        if failed: raise RuntimeError("PRIVATE BODY AND QUERY FAILURE")
    if phase == "endpoint":
        original = search._validate_endpoint
        def endpoint(value):
            result = original(value); revoke(); return result
        monkeypatch.setattr(search, "_validate_endpoint", endpoint)
    elif phase == "decode":
        original = search.json.loads
        def decode(value, *args, **kwargs):
            result = original(value, *args, **kwargs)
            # Only the proxy's bytes, not TestClient response decoding.
            if isinstance(value, bytearray): revoke()
            return result
        monkeypatch.setattr(search.json, "loads", decode)
    elif phase == "format":
        original = search._results
        def format_result(*args):
            result = original(*args); revoke(); return result
        monkeypatch.setattr(search, "_results", format_result)
    else: proxy.hooks[phase] = revoke
    result = query(client)
    assert result.status_code == 401, result.text
    assert "Private result" not in result.text and "PRIVATE" not in result.text and "results" not in result.json()
    assert result.headers["cache-control"] == "no-store"
    assert proxy.get.call_count == (0 if phase in {"endpoint", "session-enter"} else 1)
    if phase not in {"endpoint", "session-enter"}:
        assert proxy.phases.count("session-close") == 1
        if phase != "get" or not failed: assert proxy.phases.count("response-close") == 1


@pytest.mark.parametrize("phase,error,status", [("get", requests.Timeout, 504), ("get", requests.ConnectionError, 502),
    ("get", requests.HTTPError, 502), ("get", RuntimeError, 502), ("read-start", requests.Timeout, 504),
    ("read-start", requests.ConnectionError, 502), ("read-end", ValueError, 502)])
def test_upstream_errors_are_sanitized_and_resources_closed(proxy, phase, error, status):
    client, _ = proxy.browser()
    def fail(): raise error("PRIVATE URL QUERY USERNAME PASSWORD")
    proxy.hooks[phase] = fail
    result = query(client)
    assert result.status_code == status
    assert "PRIVATE" not in result.text and result.headers["cache-control"] == "no-store"
    assert proxy.get.call_count == 1 and proxy.phases.count("session-close") == 1
    if phase != "get": assert proxy.phases.count("response-close") == 1


@pytest.mark.parametrize("status", [301, 302, 307, 308, 400, 401, 403, 404, 500])
def test_redirects_and_http_errors_do_not_follow_destination_or_expose_body(proxy, status):
    client, _ = proxy.browser()
    proxy.upstream.status_code = status
    result = query(client)
    assert result.status_code == 502 and "PRIVATE" not in result.text
    assert "read-start" not in proxy.phases
    assert proxy.get.call_count == 1 and proxy.phases.count("response-close") == 1


@pytest.mark.parametrize("body", [b"not json", b"[]", b"null", b'{"results":{}}', b'{"results":null}'])
def test_invalid_upstream_payload_is_bounded_private_failure(proxy, body):
    client, _ = proxy.browser()
    proxy.chunks[:] = [body]
    result = query(client)
    assert result.status_code == 502 and result.headers["cache-control"] == "no-store"
    assert proxy.phases.count("response-close") == 1


def test_oversize_stream_stops_before_later_chunks(proxy, monkeypatch):
    client, _ = proxy.browser()
    monkeypatch.setattr(search, "MAX_RESPONSE_BYTES", 8)
    proxy.chunks[:] = [b"1234", b"56789", b"must not be read"]
    result = query(client)
    assert result.status_code == 502 and "chunk-2" not in proxy.phases
    assert proxy.phases.count("response-close") == 1 and proxy.phases.count("session-close") == 1


def test_partial_stream_revocation_never_returns_partial_results(proxy):
    client, token = proxy.browser(pin_on=True, cookie=True)
    body = proxy.chunks[0]
    proxy.chunks[:] = [body[:10], body[10:], b"not read"]
    proxy.hooks["chunk-1"] = lambda: S.revoke_session_token(token)
    result = query(client)
    assert result.status_code == 401 and "chunk-2" not in proxy.phases
    assert "results" not in result.json() and proxy.phases.count("response-close") == 1


def test_result_filter_preserves_http_links_deduplication_and_count(proxy):
    client, _ = proxy.browser()
    rows = [None, "text", {}, {"url": "javascript:alert(1)"}, {"url": "data:text/html,private"},
            {"url": "https://user:secret@example.test"}, {"url": ["invalid"]}, RESULT, RESULT,
            {"href": "http://other.example.test/", "snippet": "Fallback"}, {"url": "https://third.example.test"}]
    proxy.chunks[:] = [json.dumps({"results": rows}).encode()]
    result = query(client, k=2)
    assert result.status_code == 200
    assert result.json()["results"] == [{"url": RESULT["url"], "title": RESULT["title"], "snippet": RESULT["content"]},
                                         {"url": "http://other.example.test/", "title": "http://other.example.test/", "snippet": "Fallback"}]


def test_result_row_bound_prevents_unbounded_formatting(proxy, monkeypatch):
    client, _ = proxy.browser()
    monkeypatch.setattr(search, "MAX_RESULT_ROWS", 2)
    proxy.chunks[:] = [json.dumps({"results": [{}, {}, {}]}).encode()]
    assert query(client).status_code == 502


@pytest.mark.parametrize("change", ["pin-enabled", "security-unavailable"])
def test_open_local_access_cannot_continue_after_security_change(proxy, monkeypatch, change):
    client, _ = proxy.browser()
    def stop():
        if change == "pin-enabled": proxy.pin["enabled"] = True
        else:
            def unavailable(): raise HTTPException(503, "Security settings unavailable")
            monkeypatch.setattr(S, "load_pin_config", unavailable)
    proxy.hooks["get"] = stop
    result = query(client)
    assert result.status_code == (401 if change == "pin-enabled" else 503)
    assert "Private result" not in result.text and proxy.phases.count("response-close") == 1


def test_pin_off_bulk_revocation_during_body_completion_retires_original_access(proxy):
    client, _ = proxy.browser()
    proxy.hooks["read-end"] = S.revoke_all_sessions
    result = query(client)
    assert result.status_code == 401 and "results" not in result.json()
    assert proxy.phases.count("response-close") == 1 and proxy.phases.count("session-close") == 1


@pytest.mark.parametrize("error", [requests.Timeout, requests.ConnectionError, requests.HTTPError])
def test_revocation_wins_over_upstream_exception_category(proxy, error):
    client, token = proxy.browser(pin_on=True, cookie=True)
    def stop():
        S.revoke_session_token(token)
        raise error("PRIVATE QUERY AND TRANSPORT DETAILS")
    proxy.hooks["get"] = stop
    result = query(client)
    assert result.status_code == 401 and "PRIVATE" not in result.text
    assert proxy.phases.count("session-close") == 1


@pytest.mark.parametrize("field", ["title", "content"])
def test_invalid_unicode_cannot_escape_response_error_boundary(proxy, field):
    client, _ = proxy.browser()
    proxy.chunks[:] = [json.dumps({"results": [{**RESULT, field: "\ud800"}]}).encode()]
    result = query(client)
    assert result.status_code == 502 and result.headers["cache-control"] == "no-store"
    assert proxy.phases.count("response-close") == 1


@pytest.mark.parametrize("phase", ["get", "chunk-1", "read-end"])
def test_cooperative_elapsed_budget_stops_late_upstream_work(proxy, monkeypatch, phase):
    client, _ = proxy.browser()
    clock = [100.0]
    monkeypatch.setattr(search, "_now", lambda: clock[0])
    body = proxy.chunks[0]
    proxy.chunks[:] = [body[:10], body[10:]]
    proxy.hooks[phase] = lambda: clock.__setitem__(0, 100.0 + search.MAX_ELAPSED_SECONDS + 0.01)
    result = query(client)
    assert result.status_code == 504 and "results" not in result.json()
    assert result.headers["cache-control"] == "no-store"
    assert proxy.phases.count("response-close") == 1 and proxy.phases.count("session-close") == 1
    if phase != "read-end": assert "read-end" not in proxy.phases


def test_access_loss_takes_precedence_over_elapsed_budget(proxy, monkeypatch):
    client, token = proxy.browser(pin_on=True, cookie=True)
    clock = [100.0]
    monkeypatch.setattr(search, "_now", lambda: clock[0])
    def stop():
        clock[0] += search.MAX_ELAPSED_SECONDS + 1
        S.revoke_session_token(token)
    proxy.hooks["get"] = stop
    result = query(client)
    assert result.status_code == 401 and "timed out" not in result.text
    assert proxy.phases.count("response-close") == 1 and proxy.phases.count("session-close") == 1


def test_effective_main_route_has_browser_guard(app, proxy):
    proxy.pin["enabled"] = True
    # Construct without entering: no application lifespan or background work.
    client = TestClient(app, base_url="http://localhost:8000", client=("127.0.0.1", 1234))
    try:
        assert query(client).status_code == 401
    finally:
        client.close()
    proxy.factory.assert_not_called()
