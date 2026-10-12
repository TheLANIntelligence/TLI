"""Real authentication tests: no dependency override and no developer data/network."""
from __future__ import annotations

import base64
import json
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

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
    monkeypatch.setattr(tls_cert, "stable_lan_origins", lambda port: [])
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


def test_camera_qr_encodes_private_https_fragment_without_reencoding_der(phone, monkeypatch):
    import qrcode
    from routers import companion_routes
    certificate = base64.b64encode(bytes(range(256))).decode()
    monkeypatch.setattr(tls_cert, "certificate_bundle", lambda *a: {"certificate_der": certificate, "fingerprint": "f" * 64})
    captured = []
    original = qrcode.make
    def capture(value, **kwargs):
        captured.append(value)
        return original(value, **kwargs)
    monkeypatch.setattr(qrcode, "make", capture)
    result = phone.post(PREFIX + "/pairings", json={"origin": ORIGIN}, headers=cookie()).json()
    bundle = json.loads(result["bundle"])
    url = urlsplit(result["pairing_url"])
    fields = parse_qs(url.fragment, strict_parsing=True)
    assert result["qr_format"] == "https_fragment_v1"
    assert captured == [result["pairing_url"]] and result["qr"].startswith("data:image/svg+xml;base64,")
    assert url.scheme == "https" and url.netloc == urlsplit(ORIGIN).netloc
    assert url.path == companion_routes.PAIRING_LINK_PATH and not url.query
    assert set(fields) == {"v", "c", "t", "e", "i", "n"}
    assert fields["t"] == [bundle["token"]]
    assert base64.urlsafe_b64decode(fields["c"][0] + "=" * (-len(fields["c"][0]) % 4)) == bytes(range(256))
    assert len(fields["c"][0]) <= len(certificate)
    assert bundle["token"] not in auth._path().read_text()


def test_landing_is_public_fixed_and_never_reads_or_redeems_an_invitation(phone, monkeypatch):
    monkeypatch.setattr(auth, "redeem_pairing", lambda *a: pytest.fail("Landing attempted redemption"))
    page = phone.get(PREFIX + "/pair")
    assert page.status_code == 200
    assert page.headers["cache-control"] == "no-store"
    assert page.headers["referrer-policy"] == "no-referrer"
    assert "connect-src 'none'" in page.headers["content-security-policy"]
    assert "script-src 'self'" in page.headers["content-security-policy"]
    assert "unsafe-inline" not in page.headers["content-security-policy"]
    assert "Open TLI Companion Beta" in page.text and "/api/companion/v1/pair.js" in page.text
    assert "<style>" not in page.text
    script = phone.get(PREFIX + "/pair.js")
    assert script.status_code == 200 and script.headers["cache-control"] == "no-store"
    assert phone.get("http://192.168.1.20:8000" + PREFIX + "/pair").status_code == 403
    assert phone.get("https://8.8.8.8" + PREFIX + "/pair").status_code == 403
    ordinary = phone.get(PREFIX + "/setup", headers={**cookie(), "X-TLI-Companion-Pair-Landing": "true"})
    assert ordinary.headers["referrer-policy"] == "strict-origin-when-cross-origin"
    assert "connect-src 'self'" in ordinary.headers["content-security-policy"]
    assert not auth._path().exists()


def test_oversized_certificate_keeps_legacy_manual_bundle_without_rotating_identity(phone, monkeypatch):
    certificate = "A" * 7000
    monkeypatch.setattr(tls_cert, "certificate_bundle", lambda *a: {"certificate_der": certificate, "fingerprint": "f" * 64})
    result = phone.post(PREFIX + "/pairings", json={"origin": ORIGIN}, headers=cookie()).json()
    assert result["pairing_url"] is not None and result["qr"] is None
    assert json.loads(result["bundle"])["certificate_der"] == certificate


def test_certificate_beyond_native_limit_refuses_before_creating_invitation(phone, monkeypatch):
    monkeypatch.setattr(tls_cert, "certificate_bundle", lambda *a: {"certificate_der": "A" * 12001, "fingerprint": "f" * 64})
    result = phone.post(PREFIX + "/pairings", json={"origin": ORIGIN}, headers=cookie())
    assert result.status_code == 409
    assert not auth._path().exists()


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
    assert phone.get(PREFIX + "/bootstrap", headers=cookie()).json()["chat"] == {"path": "/chat", "streaming": False}


def test_reviewed_stable_upgrade_retains_credential_and_normalizes_default_port(phone, monkeypatch):
    import node_identity
    _, device = pair(phone)
    stable = "https://tli-home.local:443"
    monkeypatch.setattr(tls_cert, "stable_lan_origins", lambda port: [stable])
    monkeypatch.setattr(node_identity, "read_existing", lambda root: {"public_key_hex": "a" * 64})
    invitation = phone.post(PREFIX + "/pairings", json={"origin": stable}, headers=cookie())
    assert invitation.status_code == 200
    payload = json.loads(invitation.json()["bundle"])
    assert payload["version"] == 2 and payload["public_key"] == "a" * 64
    before = auth._read()["devices"]
    response = phone.post("https://tli-home.local" + PREFIX + "/pairings/upgrade", json={"token": payload["token"], "device_id": device["device_id"]}, headers=bearer(device))
    assert response.status_code == 200 and response.json()["credential_retained"] is True
    assert auth._read()["devices"] == before
    assert phone.get(PREFIX + "/preferences", headers=bearer(device)).status_code == 200
    assert phone.post("https://tli-home.local" + PREFIX + "/pairings/upgrade", json={"token": payload["token"], "device_id": device["device_id"]}, headers=bearer(device)).status_code == 403


def test_upgrade_refuses_other_owner_or_revoked_credential(phone):
    _, device = pair(phone)
    token, _ = auth.create_pairing("other", ORIGIN, "f" * 64)
    assert phone.post(PREFIX + "/pairings/upgrade", json={"token": token, "device_id": device["device_id"]}, headers=bearer(device)).status_code == 403
    auth.revoke_device("alice", device["device_id"])
    assert phone.post(PREFIX + "/pairings/upgrade", json={"token": token, "device_id": device["device_id"]}, headers=bearer(device)).status_code == 401


@pytest.fixture
def workspace_http(tmp_path, monkeypatch):
    """Real auth/HTTP and persistence, with only model execution substituted."""
    import threading
    import host_runs
    from builder import receipts
    monkeypatch.setattr(S, 'CONVERSATIONS_FILE', str(tmp_path / 'conversations.json'))
    monkeypatch.setattr(S, '_CONV_KEY', b'w' * 32)
    monkeypatch.setattr(receipts, 'BUILDER_DIR', tmp_path / 'builder')
    monkeypatch.setattr(receipts, 'STATE_PATH', tmp_path / 'builder-state.json')
    monkeypatch.setattr(receipts, 'RECEIPTS_PATH', tmp_path / 'builder-receipts.json')
    for service in (ai_routes.case_context, ai_routes.documents, ai_routes.notebook):
        monkeypatch.setattr(service, 'prepare', lambda *args, **kwargs: None)
    value = SimpleNamespace(started=threading.Event(), release=threading.Event(), calls=[])
    yield value
    value.release.set()
    with host_runs._lock:
        active = list(host_runs._runs.values())
        for run in active:
            run.stop.set()
    for run in active:
        if run.thread:
            run.thread.join(3)


def wait_for_http_run(phone, ident, headers):
    for _ in range(200):
        response = phone.get('/api/runs/' + ident, headers=headers)
        assert response.status_code == 200, response.text
        value = response.json()
        if value['status'] in {'completed', 'failed', 'cancelled', 'interrupted'}:
            return value
        time.sleep(.01)
    pytest.fail('Synthetic host run did not finish')


def workspace_stream(monkeypatch, state):
    from intelligence import chat_continuity
    host = {'id': 'host-1', 'name': 'Test host'}
    def generate(request, message, conversation_id, *_args, **_kwargs):
        state.calls.append(message)
        state.started.set()
        yield 'data: ' + json.dumps({'type': 'meta', 'conversation_id': conversation_id, 'provider': 'fixture', 'model': 'synthetic-model', 'host': host}) + '\n\n'
        yield 'data: {"type":"delta","text":"Synthetic "}\n\n'
        assert state.release.wait(5)
        # Production persistence performs the retained access/cancellation check.
        ai_routes._save_turn(conversation_id, 'user', message)
        ai_routes._save_turn(conversation_id, 'assistant', 'Synthetic answer', provider='fixture', model='synthetic-model', host=host)
        yield 'data: {"type":"delta","text":"answer"}\n\n'
        yield 'data: ' + json.dumps({'type': 'meta', **chat_continuity.source_refs(conversation_id)}) + '\n\n'
        yield 'data: {"type":"done"}\n\n'
    monkeypatch.setattr(ai_routes, '_stream_response', generate)


def test_http_browser_phone_run_resume_owner_and_settings_conflicts(phone, workspace_http, monkeypatch):
    import host_runs
    _, device = pair(phone)
    browser, mobile, foreign = cookie(), bearer(device), cookie('bob')
    state = workspace_http
    workspace_stream(monkeypatch, state)
    submission = {'request_id': 'shared-http-chat-001', 'kind': 'chat', 'payload': {'message': 'Private synthetic prompt', 'conversation_id': 'shared-http-chat'}}
    created = phone.post('/api/runs', json=submission, headers=browser)
    assert created.status_code == 202, created.text
    ident = created.json()['id']
    assert state.started.wait(3)
    running = phone.get('/api/runs/' + submission['request_id'], headers=mobile)
    assert running.status_code == 200 and running.json()['id'] == ident
    assert phone.get('/api/runs/' + ident, headers=foreign).status_code == 404
    assert phone.post('/api/runs/' + ident + '/cancel', json={}, headers=foreign).status_code == 404
    assert phone.get('/api/runs', headers=foreign).json()['runs'] == []
    conflict = {'compute_selection': None, 'expected_settings_revision': 0}
    assert phone.patch('/api/ai/conversations/shared-http-chat/settings', json=conflict, headers=mobile).status_code == 409
    assert phone.post('/api/ai/chat/stream', json={'message': 'Concurrent turn', 'conversation_id': 'shared-http-chat'}, headers=mobile).status_code == 409
    state.release.set()
    done = wait_for_http_run(phone, ident, mobile)
    assert done['status'] == 'completed' and done['text'] == 'Synthetic answer'
    assert done['metadata']['model'] == 'synthetic-model'
    assert state.calls == ['Private synthetic prompt']
    reopened = phone.get('/api/ai/conversations/shared-http-chat', headers=mobile).json()
    assert reopened == phone.get('/api/ai/conversations/shared-http-chat', headers=browser).json()
    assert reopened['messages'][-1]['source_ref'] == done['metadata']['source_ref']
    assert reopened['messages'][-1]['host'] == done['metadata']['host']['name']
    assert S.load_conversations()['shared-http-chat']['messages'][-1]['run_id'] == ident
    duplicate = phone.post('/api/runs', json=submission, headers=mobile)
    assert duplicate.status_code == 200 and duplicate.json()['id'] == ident and len(state.calls) == 1
    assert phone.post('/api/runs', json={**submission, 'payload': {'message': 'Changed'}}, headers=mobile).status_code == 409
    # Simulate replay-buffer eviction: result comes from saved owned history.
    with host_runs._lock:
        host_runs._runs.pop(ident)
    replay = phone.get('/api/runs/' + ident, headers=mobile).json()
    assert replay['result']['reply'] == 'Synthetic answer' and replay['result']['model'] == 'synthetic-model'
    stream = phone.get('/api/runs/' + ident + '/events?after=' + str(done['cursor']), headers=mobile)
    assert stream.status_code == 200 and 'event: snapshot' in stream.text and 'Synthetic answer' in stream.text
    changed = phone.patch('/api/ai/conversations/shared-http-chat/settings', json=conflict, headers=mobile)
    assert changed.status_code == 200 and changed.json()['settings_revision'] == 1
    assert phone.patch('/api/ai/conversations/shared-http-chat/settings', json=conflict, headers=browser).status_code == 409
    assert phone.get('/api/ai/conversations/shared-http-chat/settings', headers=foreign).status_code == 404
    journal = host_runs._path().read_text()
    assert 'Private synthetic prompt' not in journal and device['credential'] not in journal


def test_http_revoked_phone_stops_detached_run_before_saving(phone, workspace_http, monkeypatch):
    _, device = pair(phone)
    state = workspace_http
    workspace_stream(monkeypatch, state)
    created = phone.post('/api/runs', json={'request_id': 'revoked-http-chat-001', 'kind': 'chat', 'payload': {'message': 'Do not retain after revocation'}}, headers=bearer(device))
    assert created.status_code == 202, created.text
    ident = created.json()['id']
    assert state.started.wait(3)
    assert phone.delete(PREFIX + '/paired-devices/' + device['device_id'], headers=cookie()).status_code == 200
    state.release.set()
    done = wait_for_http_run(phone, ident, cookie())
    assert done['status'] == 'failed'
    assert phone.get('/api/runs/' + ident, headers=bearer(device)).status_code == 401
    assert phone.post('/api/runs/' + ident + '/cancel', json={}, headers=bearer(device)).status_code == 401
    assert S.load_conversations()[done['conversation_id']]['messages'] == []
    assert len(state.calls) == 1


def test_http_phone_builder_cookie_resume_and_owned_source_revision(phone, workspace_http, monkeypatch):
    import host_runs
    from builder import llm_client
    from tests.test_builder_web_apps import bundle
    _, device = pair(phone)
    state = workspace_http
    def complete(messages, *_args):
        state.calls.append(messages)
        state.started.set()
        assert state.release.wait(5)
        return json.dumps(bundle()), 'fixture-local/synthetic-model'
    monkeypatch.setattr(llm_client, '_chat', complete)
    mobile, browser, foreign = bearer(device), cookie(), cookie('bob')
    submission = {'request_id': 'shared-http-builder-001', 'kind': 'builder_create', 'payload': {'brief': 'Build a synthetic counter'}}
    created = phone.post('/api/runs', json=submission, headers=mobile)
    assert created.status_code == 202, created.text
    ident = created.json()['id']
    assert state.started.wait(3)
    assert phone.get('/api/runs/' + ident, headers=browser).status_code == 200
    assert phone.get('/api/runs/' + ident, headers=foreign).status_code == 404
    state.release.set()
    done = wait_for_http_run(phone, ident, browser)
    assert done['status'] == 'completed', done
    app_id = done['app_id']
    project = phone.get('/api/builder/web-apps/' + app_id, headers=mobile).json()['project']
    assert project == phone.get('/api/builder/web-apps/' + app_id, headers=browser).json()['project']
    assert project['revisions'][0]['backend'] == 'fixture-local/synthetic-model'
    assert project['revisions'][0]['run_id'] == ident
    assert phone.get('/api/builder/web-apps/' + app_id, headers=foreign).status_code == 404
    denied = phone.post('/api/runs', json={'request_id': 'foreign-http-builder-001', 'kind': 'builder_revise', 'app_id': app_id,
                          'payload': {'feedback': 'Replace it', 'expected_revision': 1}}, headers=foreign)
    assert denied.status_code == 404, denied.text
    duplicate = phone.post('/api/runs', json=submission, headers=browser)
    assert duplicate.status_code == 200 and duplicate.json()['id'] == ident and len(state.calls) == 1
    with host_runs._lock:
        host_runs._runs.pop(ident)
    resumed = phone.get('/api/runs/' + ident, headers=mobile).json()
    assert resumed['result']['project']['revisions'] == project['revisions']
    assert len(state.calls) == 1
