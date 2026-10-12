"""Exercise lifecycle browser authority without creating or stopping processes."""
import asyncio
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import host_control as H
import host_lifecycle as lifecycle
import tli_state as S
from ai.model_downloads import downloads
from routers import host_control_routes as R
from routers.system_routes import require_session

PREFIX = "/api/host-control/v1/lifecycle"
ORIGIN = "http://localhost:8000"
PREVIEW = "a" * 32
REQUEST = "b" * 32


@pytest.fixture
def local(monkeypatch):
    app = FastAPI()
    app.include_router(R.router)
    app.dependency_overrides[require_session] = lambda: "local"
    monkeypatch.setattr(S, "SERVER_BIND_PORT", 8000)
    monkeypatch.setattr(S, "TLS_ENABLED", False)
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": False})
    monkeypatch.setattr(S, "validate_session_token", lambda token: False)
    monkeypatch.setattr(H, "installation", lambda root: {"installation_id": "test-install"})
    monkeypatch.setattr(downloads, "status", lambda: {"in_progress": False})
    calls = []
    monkeypatch.setattr(lifecycle, "capabilities", lambda root: {"available": True, "capabilities": {"restart": True, "quit": True}})
    def preview(root, principal, action):
        calls.append(("preview", principal, action))
        return {"preview_id": PREVIEW, "action": action}
    def confirm(root, principal, preview_id, request_id):
        calls.append(("confirm", principal, preview_id, request_id))
        return {"request_id": request_id, "action": "restart", "status": "accepted"}
    monkeypatch.setattr(lifecycle, "preview", preview)
    monkeypatch.setattr(lifecycle, "confirm", confirm)
    monkeypatch.setattr(lifecycle, "dispatch", lambda root, principal, request_id: calls.append(("dispatch", principal, request_id)))
    monkeypatch.setattr(lifecycle, "fail_dispatch", lambda *args: calls.append(("failed",)), raising=False)
    return app, TestClient(app, base_url=ORIGIN, client=("127.0.0.1", 50123)), calls


def test_readiness_requires_local_origin_but_survives_locked_session(local):
    app, client, calls = local
    def locked():
        from fastapi import HTTPException
        raise HTTPException(401, "Locked")
    app.dependency_overrides[require_session] = locked
    response = client.get(PREFIX + "/ready")
    assert response.status_code == 200
    assert response.json() == {"schema_version": 1, "instance_id": R._INSTANCE_ID, "installation_id": "test-install"}
    assert response.headers["cache-control"] == "no-store"
    assert client.get(PREFIX).status_code == 401
    assert not calls


@pytest.mark.parametrize("headers", [
    {"Origin": "http://evil.example"}, {"Origin": "null"},
    {"Host": "evil.example:8000"}, {"Host": "localhost:9999"},
    {"Forwarded": "for=127.0.0.1"}, {"X-Forwarded-For": "127.0.0.1"},
    {"Authorization": "Bearer tlic_test"}, {"Sec-Fetch-Site": "cross-site"},
])
def test_desktop_boundary_rejects_foreign_authority(local, headers):
    _, client, calls = local
    assert client.get(PREFIX, headers=headers).status_code == 403
    assert client.get(PREFIX + "/ready", headers=headers).status_code == 403
    assert not calls


@pytest.mark.parametrize("peer", ["192.168.1.4", "testclient", "8.8.8.8"])
def test_lan_and_unknown_socket_cannot_control_host(local, peer):
    app, _, calls = local
    client = TestClient(app, base_url=ORIGIN, client=(peer, 4444))
    assert client.get(PREFIX).status_code == 403
    assert client.post(PREFIX + "/preview", json={"action": "quit"}, headers={"Origin": ORIGIN}).status_code == 403
    assert not calls


def test_owner_and_pin_required_even_with_forged_dependency(local, monkeypatch):
    app, client, calls = local
    app.dependency_overrides[require_session] = lambda: "someone-else"
    assert client.get(PREFIX).status_code == 403
    app.dependency_overrides[require_session] = lambda: "local"
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    assert client.get(PREFIX).status_code == 401
    assert not calls


def test_preview_is_read_only_and_confirm_dispatches_once_after_response(local):
    _, client, calls = local
    capability = client.get(PREFIX)
    assert capability.json()["instance_id"] == R._INSTANCE_ID
    assert not calls
    preview = client.post(PREFIX + "/preview", json={"action": "restart"}, headers={"Origin": ORIGIN})
    assert preview.status_code == 200
    assert [call[0] for call in calls] == ["preview"]
    response = client.post(PREFIX + "/confirm", json={"preview_id": PREVIEW, "request_id": REQUEST}, headers={"Origin": ORIGIN})
    assert response.status_code == 202
    assert response.json()["status"] == "accepted"
    assert [call[0] for call in calls] == ["preview", "confirm", "dispatch"]
    assert calls[0][1] == calls[1][1] == calls[2][1]


def test_dispatch_occurs_after_last_response_body(local, monkeypatch):
    app, _, calls = local
    body_sent = []
    def dispatch(*args):
        assert body_sent == [True]
        calls.append(("dispatch",))
    monkeypatch.setattr(lifecycle, "dispatch", dispatch)
    body = json.dumps({"preview_id": PREVIEW, "request_id": REQUEST}).encode()
    async def run():
        scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "POST",
                 "scheme": "http", "path": PREFIX + "/confirm", "raw_path": (PREFIX + "/confirm").encode(),
                 "query_string": b"", "root_path": "", "client": ("127.0.0.1", 4444), "server": ("localhost", 8000),
                 "headers": [(b"host", b"localhost:8000"), (b"origin", ORIGIN.encode()), (b"content-type", b"application/json")]}
        async def receive():
            return {"type": "http.request", "body": body}
        async def send(message):
            if message["type"] == "http.response.body" and not message.get("more_body"):
                body_sent.append(True)
        await app(scope, receive, send)
    asyncio.run(run())
    assert calls[-1][0] == "dispatch"


def test_mutation_requires_explicit_same_origin_and_strict_body(local):
    _, client, calls = local
    assert client.post(PREFIX + "/preview", json={"action": "quit"}).status_code == 403
    assert client.post(PREFIX + "/preview", json={"action": "quit"}, headers=[("Origin", ORIGIN), ("Origin", ORIGIN)]).status_code == 403
    assert client.post(PREFIX + "/preview", json={"action": "kill"}, headers={"Origin": ORIGIN}).status_code == 422
    assert client.post(PREFIX + "/preview", json={"action": "quit", "pid": 1}, headers={"Origin": ORIGIN}).status_code == 422
    assert client.post(PREFIX + "/confirm", json={"preview_id": PREVIEW, "request_id": "../x"}, headers={"Origin": ORIGIN}).status_code == 422
    assert not calls


def test_known_model_install_blocks_preview_and_confirm(local, monkeypatch):
    _, client, calls = local
    monkeypatch.setattr(downloads, "status", lambda: {"in_progress": True})
    assert client.post(PREFIX + "/preview", json={"action": "quit"}, headers={"Origin": ORIGIN}).status_code == 409
    assert client.post(PREFIX + "/confirm", json={"preview_id": PREVIEW, "request_id": REQUEST}, headers={"Origin": ORIGIN}).status_code == 409
    assert not calls


def test_revoked_session_before_background_dispatch_cannot_stop(local, monkeypatch):
    _, client, calls = local
    valid = {"yes": True}
    client.cookies.set("tli_session", "private-session")
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    monkeypatch.setattr(S, "validate_session_token", lambda token: valid["yes"])
    monkeypatch.setattr(S, "get_session_user_id", lambda token: "local")
    def confirm(*args):
        valid["yes"] = False
        return {"status": "accepted", "action": "quit", "request_id": REQUEST}
    monkeypatch.setattr(lifecycle, "confirm", confirm)
    assert client.post(PREFIX + "/confirm", json={"preview_id": PREVIEW, "request_id": REQUEST}, headers={"Origin": ORIGIN}).status_code == 202
    assert calls == [("failed",)]


def test_session_cookie_never_passed_to_service(local, monkeypatch):
    _, client, calls = local
    client.cookies.set("tli_session", "private-session")
    monkeypatch.setattr(S, "validate_session_token", lambda token: True)
    monkeypatch.setattr(S, "get_session_user_id", lambda token: "local")
    assert client.post(PREFIX + "/preview", json={"action": "quit"}, headers={"Origin": ORIGIN}).status_code == 200
    assert "private-session" not in str(calls)
    assert len(calls[0][1]) == 64


@pytest.mark.parametrize('next_url,expires_cookie', [('https://localhost:8000', True), ('http://localhost:8443', True), ('http://localhost:8000', False)])
def test_reviewed_cross_origin_restart_expires_browser_cookie_without_revoking_dispatch(local, monkeypatch, next_url, expires_cookie):
    _, client, calls = local
    client.cookies.set('tli_session', 'private-session')
    monkeypatch.setattr(S, 'load_pin_config', lambda: {'enabled': True})
    monkeypatch.setattr(S, 'validate_session_token', lambda token: token == 'private-session')
    monkeypatch.setattr(S, 'get_session_user_id', lambda token: 'local')
    monkeypatch.setattr(lifecycle, 'confirm', lambda *args: {'request_id': REQUEST, 'action': 'restart', 'status': 'accepted', 'next_url': next_url})
    response = client.post(PREFIX + '/confirm', json={'preview_id': PREVIEW, 'request_id': REQUEST}, headers={'Origin': ORIGIN})
    assert response.status_code == 202
    assert ('Max-Age=0' in response.headers.get('set-cookie', '')) is expires_cookie
    assert [call[0] for call in calls] == ['dispatch']
