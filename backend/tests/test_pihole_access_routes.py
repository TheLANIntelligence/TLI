"""Actual HTTP guards and browser-only guest credentials, independent of owner PIN."""
import asyncio
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request
import pytest

from routers import pihole_access_routes as routes
import tli_state as S

PROTOCOL = "tli-pihole-access-v1"


@pytest.fixture
def web(monkeypatch, tmp_path):
    monkeypatch.setattr(S, "DATA_DIR", tmp_path)
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(S, "TLS_ENABLED", False)
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True, "salt": "salt", "hash": "hash"})
    app = FastAPI(); app.include_router(routes.router)
    clients = []
    def browser(*, scheme="https", host="192.168.1.2:8000", source="192.168.1.40", owner=False):
        base = scheme + "://" + host
        client = TestClient(app, base_url=base, client=(source, 1234), headers={"Origin": base, "Sec-Fetch-Site": "same-origin"}, raise_server_exceptions=False)
        token = S.create_session_token("owner") if owner else None
        if token: client.headers["Cookie"] = "tli_session=" + token
        clients.append(client)
        return client, token
    yield SimpleNamespace(browser=browser, app=app)
    for client in clients: client.close()


@pytest.mark.parametrize("mode", ["http", "public-host", "hostname", "public-source", "link-local", "loopback", "cross-origin", "cross-site", "missing-origin", "forwarded", "bearer", "peer", "duplicate-host", "malformed-host"])
def test_guest_transport_denies_before_service_or_body(web, monkeypatch, mode):
    client, _ = web.browser(scheme="http" if mode == "http" else "https",
        host="8.8.8.8" if mode == "public-host" else "tli.example" if mode == "hostname" else "192.168.1.2:8000",
        source={"public-source": "8.8.8.8", "link-local": "169.254.1.1", "loopback": "127.0.0.1"}.get(mode, "192.168.1.40"))
    if mode == "cross-origin": client.headers["Origin"] = "https://untrusted.example"
    if mode == "cross-site": client.headers["Sec-Fetch-Site"] = "cross-site"
    if mode == "missing-origin": del client.headers["Origin"]
    if mode == "forwarded": client.headers["Forwarded"] = "for=192.168.1.40"
    if mode == "bearer": client.headers["Authorization"] = "Bearer PRIVATE-PHONE-TOKEN"
    if mode == "peer": client.headers["X-TLI-Peer-Signature"] = "PRIVATE-PEER"
    if mode == "duplicate-host": client.headers.update([("Host", "192.168.1.2:8000"), ("Host", "192.168.1.2:8000")])
    if mode == "malformed-host": client.headers["Host"] = "192.168.1.2:99999"
    action = Mock(); monkeypatch.setattr(routes.service, "filtering", action)
    response = client.post("/api/pihole-access/filtering", content=b"PRIVATE-INVALID", headers={"Content-Type": "application/json"})
    assert response.status_code == 403 and "PRIVATE" not in response.text
    assert response.headers["cache-control"] == "no-store"
    action.assert_not_called()


def test_guest_cookie_is_scoped_secure_httponly_and_not_returned_in_json(web, monkeypatch):
    client, _ = web.browser()
    credential = "a" * 32 + "." + "b" * 64
    def request_access(request, data, check):
        check()
        return {"ok": True, "protocol": PROTOCOL, "state": "pending", "_credential": credential, "_access_check": check}
    monkeypatch.setattr(routes.service, "request_access", request_access)
    response = client.post("/api/pihole-access/request", json={"name": "My phone"})
    assert response.status_code == 200, response.text
    assert credential not in response.text and "_access_check" not in response.text
    cookie = response.headers["set-cookie"]
    assert all(value in cookie for value in ("Secure", "HttpOnly", "SameSite=strict", "Path=/api/pihole-access"))
    assert "tli_session" not in cookie
    def read(request, check):
        assert request.cookies[routes.COOKIE] == credential
        return {"ok": True, "protocol": PROTOCOL, "state": "pending", "_access_check": check}
    monkeypatch.setattr(routes.service, "guest_status", read)
    assert client.get("/api/pihole-access/status").status_code == 200
    # The separate guest grant does not satisfy the existing owner HTTP boundary.
    owner = Mock(); monkeypatch.setattr(routes.service, "owner_status", owner)
    response = client.get("/api/homelab/pihole/self-service/status")
    assert response.status_code == 401
    owner.assert_not_called()


def test_guest_live_check_runs_after_json_serialization(web, monkeypatch):
    client, _ = web.browser()
    valid = True
    def final_check():
        if not valid: raise HTTPException(403, "Grant revoked")
    monkeypatch.setattr(routes.service, "guest_status", lambda *args: {
        "ok": True, "protocol": PROTOCOL, "client": "PRIVATE-DEVICE", "_access_check": final_check})
    original = routes.JSONResponse
    def response(*args, **kwargs):
        nonlocal valid
        value = original(*args, **kwargs); valid = False
        return value
    monkeypatch.setattr(routes, "JSONResponse", response)
    result = client.get("/api/pihole-access/status")
    assert result.status_code == 403 and "PRIVATE" not in result.text


@pytest.mark.parametrize("operation,body", [("filtering", {"enabled": False,"operation_id": "x", "client": "192.168.1.99"}),
    ("filtering", {"enabled": 1,"operation_id": "x"}), ("filtering", {"enabled": False,"operation_id": "x", "groups": []}),
    ("request", {"name": "test", "approved": True}), ("request", {"name": "\ud800"})])
def test_guest_cannot_supply_target_groups_or_authority(web, monkeypatch, operation, body):
    client, _ = web.browser()
    action = Mock(); monkeypatch.setattr(routes.service, "filtering" if operation == "filtering" else "request_access", action)
    response = client.post("/api/pihole-access/" + operation, content=__import__('json').dumps(body), headers={"Content-Type":"application/json"})
    assert response.status_code == 422
    action.assert_not_called()


@pytest.mark.parametrize("operation", ["enable", "disable", "inventory", "approve", "revoke"])
def test_owner_control_keeps_original_browser_through_result(web, monkeypatch, operation):
    client, token = web.browser(owner=True)
    data = {"enable": {"origin":"https://192.168.1.3","password":"PRIVATE-PASSWORD","certificate_sha256":""},
        "disable":{},"inventory":{},"approve":{"request_id":"x","client":"192.168.1.40","reviewed":True},"revoke":{"grant_id":"x"}}[operation]
    def action(request, data, check):
        check(); S.revoke_session_token(token)
        return {"private":"PRIVATE-RESULT"}
    monkeypatch.setattr(routes.service, "owner_inventory" if operation=="inventory" else operation, action)
    response = client.post("/api/homelab/pihole/self-service/"+operation,json=data)
    assert response.status_code == 401 and "PRIVATE" not in response.text


def test_forget_clears_only_guest_cookie(web, monkeypatch):
    client, _ = web.browser()
    monkeypatch.setattr(routes.service, "forget", lambda *args: {"ok":True,"protocol":PROTOCOL,"forgotten":True})
    result = client.post("/api/pihole-access/forget",json={})
    assert result.status_code == 200
    assert "tli_pihole_access=" in result.headers["set-cookie"] and "Max-Age=0" in result.headers["set-cookie"]
    assert "tli_session" not in result.headers["set-cookie"]


def test_slow_and_oversized_request_bodies_fail_without_service(web, monkeypatch):
    client, _ = web.browser()
    service = Mock(); monkeypatch.setattr(routes.service, "request_access", service)
    response = client.post("/api/pihole-access/request",content=b'x'*8193,headers={"Content-Type":"application/json"})
    assert response.status_code == 413
    service.assert_not_called()
    async def slow():
        async def receive():
            await asyncio.sleep(.05)
            return {"type":"http.request","body":b'{}',"more_body":False}
        request = Request({"type":"http","method":"POST","path":"/","headers":[(b'content-type',b'application/json')]},receive)
        with pytest.raises(HTTPException) as error: await routes._payload(request,lambda:None,"request")
        assert error.value.status_code == 408
    monkeypatch.setattr(routes,"BODY_SECONDS",.01)
    asyncio.run(slow())


def test_public_page_has_restricted_policy_in_real_app(client):
    for path in ("/pihole-access", "/pihole-access.html"):
        result = client.get(path)
        assert result.status_code == 200
        assert result.headers["cache-control"] == "no-store"
        assert result.headers["referrer-policy"] == "no-referrer"
        assert "frame-ancestors 'none'" in result.headers["content-security-policy"]
        assert "connect-src 'self'" in result.headers["content-security-policy"]
        assert "unsafe-inline" not in result.headers["content-security-policy"]
        assert 'pihole-access.js' in result.text and '/app.js' not in result.text
