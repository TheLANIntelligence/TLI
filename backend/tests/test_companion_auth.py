"""Real authentication tests: no dependency override and no developer data/network."""
from __future__ import annotations

import base64
import json
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request

import companion_auth as auth
import tli_state as S
import tls_cert
from ai import ai_routes
from intelligence import context, diagnostics, models, vision
from intelligence.store import write_private
from routers.system_routes import require_session

ORIGIN = "https://192.168.1.20:8000"
PREFIX = "/api/companion/v1"


@pytest.fixture(autouse=True)
def isolated_companion(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "TLS_ENABLED", True)
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(S, "load_node_config", lambda: SimpleNamespace(node_id="host-1", node_name="Test host", role="standalone"))
    monkeypatch.setattr(tls_cert, "_local_ipv4_addresses", lambda: ["192.168.1.20", "127.0.0.1", "8.8.8.8"])
    monkeypatch.setattr(tls_cert, "certificate_bundle", lambda *a: {"certificate_der": "dGVzdC1jZXJ0", "fingerprint": "f" * 64})
    monkeypatch.setattr(ai_routes, "_find_mesh_ai_peer", lambda: None)
    monkeypatch.setattr(ai_routes, "_MESH_CACHE", {"ts": 0, "peers": []})
    monkeypatch.setattr(S, "load_mesh_directory", lambda: {})
    monkeypatch.setattr(models, "image_provider", lambda: (_ for _ in ()).throw(HTTPException(409, "Unavailable")))
    monkeypatch.setenv("TLI_PORT", "8000")
    monkeypatch.setenv("TLI_LAN_MODE", "1")
    monkeypatch.delenv("TLI_HOST", raising=False)
    monkeypatch.delattr(S, "SERVER_BIND_HOST", raising=False)
    monkeypatch.delattr(S, "SERVER_BIND_PORT", raising=False)


@pytest.fixture
def phone(app):
    with TestClient(app, base_url=ORIGIN, raise_server_exceptions=True) as client:
        yield client


def cookie(owner="alice"):
    return {"Cookie": "tli_session=" + S.create_session_token(owner)}


def pair(phone, owner="alice"):
    created = phone.post(PREFIX + "/pairings", json={"origin": ORIGIN}, headers=cookie(owner))
    assert created.status_code == 200, created.text
    data = created.json()
    bundle = json.loads(data["bundle"])
    redeemed = phone.post(PREFIX + "/pairings/redeem", json={"token": bundle["token"], "name": "My phone", "platform": "ios"})
    assert redeemed.status_code == 200, redeemed.text
    return bundle, redeemed.json()


def bearer(device):
    return {"Authorization": "Bearer " + device["credential"]}


def test_pairing_requires_pin_and_real_browser_cookie(phone, monkeypatch):
    assert phone.get(PREFIX + "/setup").status_code == 401
    assert phone.post(PREFIX + "/pairings", json={"origin": ORIGIN}).status_code == 401
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": False})
    setup = phone.get(PREFIX + "/setup").json()
    assert setup["pin_enabled"] is False and setup["pairing_ready"] is False
    assert phone.post(PREFIX + "/pairings", json={"origin": ORIGIN}, headers=cookie()).status_code == 409


def test_bundle_hash_storage_single_use_and_owner_preferences(phone):
    bundle, device = pair(phone)
    assert set(bundle) == {"version", "origin", "certificate_der", "token", "expires_at", "node_id", "node_name"}
    assert device["owner_id"] == "alice" and device["node"]["id"] == "host-1"
    disk = auth._path().read_text()
    assert bundle["token"] not in disk and device["credential"] not in disk
    assert auth._hash(device["credential"]) in disk
    assert phone.post(PREFIX + "/pairings/redeem", json={"token": bundle["token"], "name": "Second", "platform": "android"}).status_code == 403
    prefs = {"favorite_devices": ["lamp-1", "lamp-1"], "favorite_scenes": ["night"], "theme": "dark"}
    saved = phone.put(PREFIX + "/preferences", json=prefs, headers=bearer(device))
    assert saved.status_code == 200
    assert saved.json()["favorite_devices"] == ["lamp-1"]
    assert phone.get(PREFIX + "/preferences", headers=cookie()).json() == saved.json()
    assert phone.get(PREFIX + "/preferences", headers=cookie("bob")).json()["favorite_devices"] == []
    # Re-read from disk on every use: no in-memory credential cache to survive revocation.
    assert auth.credential_owner(device["credential"]) == "alice"


def test_pairing_expired_origin_mismatch_and_certificate_rotation(phone, monkeypatch):
    created = phone.post(PREFIX + "/pairings", json={"origin": ORIGIN}, headers=cookie()).json()
    token = json.loads(created["bundle"])["token"]
    payload = {"token": token, "name": "My phone", "platform": "ios"}
    wrong = phone.post("https://192.168.1.21:8000" + PREFIX + "/pairings/redeem", json=payload)
    assert wrong.status_code == 403
    monkeypatch.setattr(tls_cert, "certificate_bundle", lambda *a: {"certificate_der": "new", "fingerprint": "a" * 64})
    assert phone.post(PREFIX + "/pairings/redeem", json=payload).status_code == 403
    monkeypatch.setattr(auth.time, "time", lambda: 9999999999)
    assert phone.post(PREFIX + "/pairings/redeem", json=payload).status_code == 403


def test_concurrent_redemption_only_issues_one_device(phone):
    created = phone.post(PREFIX + "/pairings", json={"origin": ORIGIN}, headers=cookie()).json()
    token = json.loads(created["bundle"])["token"]
    def attempt(_):
        try:
            return auth.redeem_pairing(token, ORIGIN, "f" * 64, "Phone", "ios")
        except HTTPException as error:
            return error.status_code
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(attempt, range(4)))
    assert sum(isinstance(result, dict) for result in results) == 1
    assert results.count(403) == 3
    assert len(auth.paired_devices("alice")) == 1


@pytest.mark.parametrize("authorization", ["", "Basic abc", "Bearer", "Bearer bogus", "Bearer a b", "Bearer tlic_" + "x" * 43])
def test_invalid_authorization_never_falls_back(phone, monkeypatch, authorization):
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": False})
    headers = {**cookie(), "Authorization": authorization}
    for path in (PREFIX + "/preferences", "/api/ai/conversations", "/api/intelligence/images", "/api/intelligence/diagnostics"):
        assert phone.get(path, headers=headers).status_code == 401
    assert phone.post("/api/ai/chat/stream", json={"message": "hello"}, headers=headers).status_code == 401
    assert phone.post("/api/ai/chat", json={"message": "hello"}, headers=headers).status_code == 401
    assert phone.post("/chat", json={"message": "hello"}, headers=headers).status_code == 401


def test_revocation_and_cross_owner_device_access(phone, monkeypatch):
    _, device = pair(phone)
    assert phone.get(PREFIX + "/bootstrap", headers=bearer(device)).status_code == 200
    listing = phone.get(PREFIX + "/paired-devices", headers=cookie()).json()["devices"]
    assert listing[0]["id"] == device["device_id"]
    assert "credential" not in str(listing) and "owner_id" not in str(listing)
    assert phone.delete(PREFIX + "/paired-devices/" + device["device_id"], headers=cookie("bob")).status_code == 404
    assert phone.delete(PREFIX + "/paired-devices/" + device["device_id"], headers=cookie()).status_code == 200
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": False})
    assert phone.get(PREFIX + "/preferences", headers=bearer(device)).status_code == 401
    assert phone.post("/api/ai/chat/stream", json={"message": "hello"}, headers=bearer(device)).status_code == 401
    for path in ("/homepower/devices", "/homepower/scenes", "/health", "/system/summary"):
        assert phone.get(path, headers=bearer(device)).status_code == 401


def test_credentials_and_redemption_never_cross_http(phone):
    bundle, device = pair(phone)
    assert phone.get("http://192.168.1.20:8000" + PREFIX + "/preferences", headers=bearer(device)).status_code == 403
    assert phone.get("http://192.168.1.20:8000/homepower/devices", headers=bearer(device)).status_code == 403
    assert phone.post("http://192.168.1.20:8000" + PREFIX + "/pairings/redeem", json={"token": bundle["token"], "name": "Phone", "platform": "ios"}).status_code == 403
    assert phone.post(PREFIX + "/pairings", json={"origin": ORIGIN}, headers=bearer(device)).status_code == 403


@pytest.mark.parametrize("origin", ["http://192.168.1.20:8000", "https://127.0.0.1:8000", "https://8.8.8.8", "https://evil.example", ORIGIN + "/evil", "https://192.168.1.21:8000"])
def test_unadvertised_origins_cannot_get_pairing_codes(phone, origin):
    assert phone.post(PREFIX + "/pairings", json={"origin": origin}, headers=cookie()).status_code == 422


def test_setup_fails_closed_for_tls_or_missing_san(phone, monkeypatch):
    setup = phone.get(PREFIX + "/setup", headers=cookie()).json()
    assert setup["origins"] == [ORIGIN] and setup["pairing_ready"] is True
    monkeypatch.setattr(S, "TLS_ENABLED", False)
    assert phone.post(PREFIX + "/pairings", json={"origin": ORIGIN}, headers=cookie()).status_code == 409
    monkeypatch.setattr(S, "TLS_ENABLED", True)
    monkeypatch.setattr(tls_cert, "certificate_bundle", lambda *a: (_ for _ in ()).throw(ValueError("Missing SAN")))
    setup = phone.get(PREFIX + "/setup", headers=cookie()).json()
    assert setup["origins"] == [] and setup["certificate_ready"] is False
    assert "Missing SAN" in setup["reason"]


def test_setup_requires_actual_lan_binding_and_uses_runtime_port(phone, monkeypatch):
    monkeypatch.setenv("TLI_LAN_MODE", "0")
    setup = phone.get(PREFIX + "/setup", headers=cookie()).json()
    assert setup["lan_enabled"] is False and setup["origins"] == []
    assert "LAN" in setup["reason"]
    monkeypatch.setattr(S, "SERVER_BIND_HOST", "192.168.1.20", raising=False)
    monkeypatch.setattr(S, "SERVER_BIND_PORT", 8443, raising=False)
    setup = phone.get(PREFIX + "/setup", headers=cookie()).json()
    assert setup["origins"] == ["https://192.168.1.20:8443"]


def test_duplicate_authorization_headers_rejected_before_public_routes(phone):
    _, device = pair(phone)
    headers = [("Authorization", "Bearer " + device["credential"]), ("Authorization", "Bearer invalid")]
    assert phone.get("/homepower/devices", headers=headers).status_code == 401


def test_cross_site_pairing_and_invalid_platform_rejected(phone):
    assert phone.post(PREFIX + "/pairings", json={"origin": ORIGIN}, headers={**cookie(), "Origin": "https://evil.example"}).status_code == 403
    assert phone.post(PREFIX + "/pairings/redeem", json={"token": "x" * 43, "name": "Phone", "platform": "web"}).status_code == 422


def test_shared_private_resources_and_stream_identity(phone, monkeypatch):
    _, device = pair(phone)
    monkeypatch.setattr(S, "load_conversations", lambda: {"owned": {"id": "owned", "user_id": "alice", "title": "Desktop chat", "messages": [{"role": "user", "content": "hello"}]}, "foreign": {"id": "foreign", "user_id": "bob", "title": "Private", "messages": []}})
    assert phone.get("/api/ai/conversations/owned", headers=bearer(device)).status_code == 200
    assert phone.get("/api/ai/conversations/foreign", headers=bearer(device)).status_code == 404
    assert phone.get("/api/ai/conversations", headers=bearer(device)).json() == phone.get("/api/ai/conversations", headers=cookie()).json()
    write_private("alice", "diagnostics", [{"id": "alice-report"}])
    write_private("bob", "diagnostics", [{"id": "bob-report"}])
    assert phone.get("/api/intelligence/diagnostics/alice-report", headers=bearer(device)).status_code == 200
    assert phone.get("/api/intelligence/diagnostics/bob-report", headers=bearer(device)).status_code == 404
    write_private("alice", "images", [{"id": "alice-image", "expires_at": 9999999999, "mime": "image/jpeg", "b64": base64.b64encode(b"test-image").decode()}])
    assert phone.get("/api/intelligence/images/alice-image", headers=bearer(device)).content == b"test-image"
    assert phone.get("/api/intelligence/images/alice-image", headers=cookie("bob")).status_code == 404
    request = Request({"type": "http", "scheme": "https", "server": ("192.168.1.20", 8000), "path": "/", "headers": [(b"authorization", bearer(device)["Authorization"].encode())]})
    assert context.request_user(request) == "alice"
    captured = []
    monkeypatch.setattr(ai_routes, "_get_or_create_conv", lambda *a, **kw: captured.append(kw["user_id"]) or "owned")
    monkeypatch.setattr(ai_routes, "_stream_response", lambda *a, **kw: iter(['data: {"type":"done"}\n\n']))
    assert phone.post("/api/ai/chat/stream", json={"message": "hello"}, headers=bearer(device)).status_code == 200
    assert captured == ["alice"]


def test_direct_cookie_dependency_and_corrupt_store_fail_closed(phone):
    token = S.create_session_token("alice")
    assert require_session(token) == "alice"
    with pytest.raises(HTTPException):
        require_session()
    _, device = pair(phone)
    auth._path().write_text("{broken", encoding="utf-8")
    assert phone.get(PREFIX + "/preferences", headers=bearer(device)).status_code == 503


def test_bootstrap_selects_existing_transport_without_starting_model(phone, monkeypatch):
    from ai.ai_manager import BundledAIManager
    monkeypatch.setattr(BundledAIManager, "ensure_running", lambda *a: pytest.fail("Bootstrap started inference"))
    assert phone.get(PREFIX + "/bootstrap", headers=cookie()).json()["chat"] == {"path": "/chat", "streaming": False}
    monkeypatch.setattr(ai_routes, "_MESH_CACHE", {"ts": time.time(), "peers": [{"ip": "192.168.1.25"}]})
    assert phone.get(PREFIX + "/bootstrap", headers=cookie()).json()["chat"] == {"path": "/api/ai/chat/stream", "streaming": True}
