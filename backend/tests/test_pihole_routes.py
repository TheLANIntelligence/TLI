"""HTTP admission, bounded credential bodies and late-disclosure authorization."""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request
import pytest

import tli_state as S
from routers import pihole_routes as routes

PAYLOADS = {
    "connect": {"origin": "https://192.168.1.2", "password": "PRIVATE-PASSWORD", "certificate_sha256": ""},
    "inventory": {"connection_id": "test"}, "activity": {"connection_id": "test", "client": "192.168.1.40"},
    "review": {"connection_id": "test", "client": "192.168.1.40", "action": "pause", "groups": [], "receipt_id": None},
    "execute": {"connection_id": "test", "review_id": "review", "reviewed": True}, "disconnect": {"connection_id": "test"}}


@pytest.fixture
def web(monkeypatch, tmp_path):
    monkeypatch.setattr(S, "DATA_DIR", tmp_path)
    monkeypatch.setattr(S, "_active_sessions", {})
    pin = {"enabled": True}
    monkeypatch.setattr(S, "load_pin_config", lambda: dict(pin))
    app = FastAPI(); app.include_router(routes.router)
    clients = []
    def browser(mode="pin"):
        pin["enabled"] = mode != "pin-off"
        client = TestClient(app, base_url="http://localhost:8000", client=("127.0.0.1", 1234),
            headers={"Origin": "http://localhost:8000", "Sec-Fetch-Site": "same-origin"}, raise_server_exceptions=False)
        token = S.create_session_token("owner")
        if mode != "missing-cookie": client.headers["Cookie"] = "tli_session=" + token
        if mode == "stale-cookie": S.revoke_session_token(token)
        if mode == "bearer": client.headers["Authorization"] = "Bearer PRIVATE-NATIVE"
        if mode == "peer": client.headers["X-TLI-Peer-Signature"] = "PRIVATE-PEER"
        if mode == "cross-origin": client.headers["Origin"] = "http://untrusted.example"
        if mode == "forwarded": client.headers["X-Forwarded-For"] = "127.0.0.1"
        clients.append(client)
        return client, token
    yield SimpleNamespace(browser=browser, pin=pin, root=tmp_path, app=app)
    for client in clients: client.close()


def send(client, endpoint, **kwargs):
    return client.get("/api/homelab/pihole/status", **kwargs) if endpoint == "status" else client.post("/api/homelab/pihole/" + endpoint, json=PAYLOADS[endpoint], **kwargs)


@pytest.mark.parametrize("endpoint", ["status", *PAYLOADS])
@pytest.mark.parametrize("mode", ["missing-cookie", "stale-cookie", "bearer", "peer", "cross-origin", "forwarded", "pin-off"])
def test_actual_browser_denial_precedes_network_and_private_store(web, monkeypatch, endpoint, mode):
    client, _ = web.browser(mode)
    network = Mock(side_effect=AssertionError("No upstream request allowed"))
    monkeypatch.setattr(routes.pihole_bridge.transport, "exchange", network)
    store = Mock(side_effect=AssertionError("No private recovery read allowed"))
    monkeypatch.setattr(routes.pihole_bridge, "_store", store)
    response = send(client, endpoint)
    assert response.status_code in (401, 403), response.text
    assert response.headers["cache-control"] == "no-store"
    assert "PRIVATE" not in response.text
    network.assert_not_called(); store.assert_not_called()


@pytest.mark.parametrize("endpoint", list(PAYLOADS))
def test_valid_json_calls_exact_service_and_late_revoke_denies_disclosure(web, monkeypatch, endpoint):
    client, token = web.browser()
    def service(request, value, check):
        assert value == PAYLOADS[endpoint]
        check()
        S.revoke_session_token(token)
        return {"private": "PRIVATE-RESULT"}
    monkeypatch.setattr(routes.pihole_bridge, endpoint, service)
    response = send(client, endpoint)
    assert response.status_code == 401 and "PRIVATE" not in response.text
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("raw", [b'{', b'[]', b'{"password":"PRIVATE","password":"PRIVATE"}',
    b'{"origin":"x","password":"PRIVATE","certificate_sha256":"","extra":1}',
    b'{"origin":"x","password":123,"certificate_sha256":""}',
    b'{"origin":"x","password":"PRIVATE","certificate_sha256":"\\ud800"}',
    b'{"origin":"x","password":NaN,"certificate_sha256":""}', b'x' * 8193])
def test_bad_credential_bodies_are_static_bounded_errors(web, monkeypatch, raw):
    client, _ = web.browser()
    service = Mock(); monkeypatch.setattr(routes.pihole_bridge, "connect", service)
    response = client.post("/api/homelab/pihole/connect", content=raw, headers={"Content-Type": "application/json"})
    assert response.status_code in (413, 422) and "PRIVATE" not in response.text
    assert response.headers["cache-control"] == "no-store"
    service.assert_not_called()


@pytest.mark.parametrize("operation,field,value", [("execute", "reviewed", False), ("execute", "reviewed", 1),
    ("review", "groups", [True]), ("review", "groups", [0, 0]), ("review", "groups", [2**60]), ("review", "action", "global-disable")])
def test_invalid_control_fields_never_call_service(web, monkeypatch, operation, field, value):
    client, _ = web.browser()
    service = Mock(); monkeypatch.setattr(routes.pihole_bridge, operation, service)
    body = {**PAYLOADS[operation], field: value}
    response = client.post("/api/homelab/pihole/" + operation, json=body)
    assert response.status_code == 422
    service.assert_not_called()


def test_status_checks_before_private_json_encoding(web, monkeypatch):
    client, token = web.browser()
    def service(request, check):
        check(); S.revoke_session_token(token)
        return {"private": "PRIVATE-RESULT"}
    monkeypatch.setattr(routes.pihole_bridge, "status", service)
    response = send(client, "status")
    assert response.status_code == 401 and "PRIVATE" not in response.text


def test_raw_service_failure_cannot_reflect_credentials(web, monkeypatch):
    client, _ = web.browser()
    monkeypatch.setattr(routes.pihole_bridge, "connect", Mock(side_effect=RuntimeError("PRIVATE-PASSWORD")))
    response = send(client, "connect")
    assert response.status_code == 503 and "PRIVATE" not in response.text
    assert response.headers["cache-control"] == "no-store"


def test_slow_body_and_revocation_between_chunks(monkeypatch):
    async def run(revoke):
        count = 0
        def check():
            if revoke and count: raise HTTPException(401, "revoked")
        async def receive():
            nonlocal count
            if not revoke: await asyncio.sleep(.05)
            count += 1
            return {"type": "http.request", "body": b'{"password":"PRIVATE"', "more_body": True}
        request = Request({"type": "http", "method": "POST", "path": "/", "headers": [(b"content-type", b"application/json")]}, receive)
        with pytest.raises(HTTPException) as error: await routes._payload(request, check, "connect")
        assert error.value.status_code == (401 if revoke else 408)
    monkeypatch.setattr(routes, "MAX_BODY_SECONDS", .01)
    asyncio.run(run(False)); asyncio.run(run(True))
