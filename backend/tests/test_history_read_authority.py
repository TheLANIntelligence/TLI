"""Captured history reads with real browser/Companion credentials and no models."""
import json
from pathlib import Path
from types import SimpleNamespace

from fastapi import HTTPException
from fastapi.testclient import TestClient
import pytest

import companion_auth as companion
import private_client_authority as authority
import tli_state as S
import workspace_settings
from ai import ai_routes
from intelligence import conversation_search as search
from routers.system_routes import require_session


ROUTES = ["/conversations", "/conversations/mine", "/api/ai/conversations",
          "/api/ai/conversations/mine", "/api/intelligence/conversation-search?q=PRIVATE",
          "/api/intelligence/conversation-search/capabilities", "/api/ai/conversations/mine/settings"]
DATA_ROUTES = [route for route in ROUTES if not route.endswith("/capabilities")]


@pytest.fixture
def history(app, tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "CONVERSATIONS_FILE", str(tmp_path / "conversations.json"))
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(S, "_session_revocation_epoch", object())
    monkeypatch.setattr(search, "_cursors", {})
    pin = {"enabled": True}
    monkeypatch.setattr(S, "load_pin_config", lambda: dict(pin))
    clients = []
    def seed(owner="alice"):
        def row(ident, user, **extra):
            return {"id": ident, "user_id": user, "title": "PRIVATE " + ident,
                    "device_id": "device-one", "last_updated": "2026-10-17T12:00:00Z",
                    "messages": [{"role": "system", "content": "PRIVATE hidden"},
                                 {"role": "user", "content": "PRIVATE question", "compatible": 17},
                                 {"role": "assistant", "content": "PRIVATE answer", "provider": "bundled"}],
                    "compatible": {"retained": True}, "compute_selection": None, "settings_revision": 3, **extra}
        value = {"mine": row("mine", owner), "foreign": row("foreign", "bob"),
                 "peer": row("peer", owner, mesh_source_ip="192.0.2.40"), "old": row("old", "bundled-ai")}
        Path(S.CONVERSATIONS_FILE).write_text(json.dumps(value), encoding="utf-8")
        return value
    seed()
    def connect(mode="browser"):
        origin = "http://localhost:8000" if mode == "local" else "https://tli.invalid"
        client = TestClient(app, base_url=origin, client=("127.0.0.1" if mode == "local" else "192.0.2.20", 1234),
                            raise_server_exceptions=False)
        clients.append(client)
        if mode == "native":
            invite, _ = companion.create_pairing("alice", origin, "synthetic-fingerprint")
            device = companion.redeem_pairing(invite, origin, "synthetic-fingerprint", "Test phone", "synthetic")
            client.headers["Authorization"] = "Bearer " + device["credential"]
            revoke = lambda: companion.revoke_device("alice", device["device_id"])
        elif mode == "local":
            pin["enabled"] = False
            client.headers["Origin"] = origin
            revoke = lambda: setattr(S, "_session_revocation_epoch", object())
        else:
            token = S.create_session_token("alice")
            client.headers.update({"Cookie": "tli_session=" + token, "Origin": origin})
            revoke = lambda: S.revoke_session_token(token)
        return client, revoke
    real_save = S.save_conversations
    monkeypatch.setattr(S, "save_conversations", lambda *a, **kw: pytest.fail("A history GET attempted persistence"))
    yield SimpleNamespace(connect=connect, seed=seed, path=Path(S.CONVERSATIONS_FILE), pin=pin, app=app, real_save=real_save)
    for client in clients:
        client.close()


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize("mode", ["browser", "native"])
def test_history_reads_support_both_credentials_without_writes(history, route, mode):
    client, _ = history.connect(mode)
    before = history.path.read_bytes()
    response = client.get(route)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    assert "PRIVATE foreign" not in response.text
    assert history.path.read_bytes() == before


@pytest.mark.parametrize("route", ROUTES)
def test_owner_dependency_override_never_grants_history_access(history, monkeypatch, route):
    client, _ = history.connect()
    del client.headers["Cookie"]
    monkeypatch.setitem(history.app.dependency_overrides, require_session, lambda: "alice")
    response = client.get(route)
    assert response.status_code == 401
    assert "PRIVATE" not in response.text
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("route", DATA_ROUTES)
@pytest.mark.parametrize("mode", ["browser", "native"])
def test_revocation_after_private_read_withholds_entire_response(history, monkeypatch, route, mode):
    client, revoke = history.connect(mode)
    module, name = (search, "_read") if "conversation-search" in route else (S, "load_conversations")
    original = getattr(module, name)
    def read(*args, **kwargs):
        assert kwargs.get("check") is not None or args and callable(args[0])
        result = original(*args, **kwargs)
        revoke()
        return result
    monkeypatch.setattr(module, name, read)
    response = client.get(route)
    assert response.status_code == 401, response.text
    assert "PRIVATE" not in response.text


@pytest.mark.parametrize("route", ROUTES)
@pytest.mark.parametrize("mode", ["browser", "native"])
def test_revocation_during_response_encoding_withholds_encoded_bytes(history, monkeypatch, route, mode):
    client, revoke = history.connect(mode)
    original = authority.JSONResponse
    def encode(*args, **kwargs):
        response = original(*args, **kwargs)
        revoke()
        return response
    monkeypatch.setattr(authority, "JSONResponse", encode)
    response = client.get(route)
    assert response.status_code == 401, response.text
    assert "PRIVATE" not in response.text and response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("route", DATA_ROUTES)
def test_revocation_while_waiting_for_store_lock_stops_read(history, monkeypatch, route):
    client, revoke = history.connect()
    real_lock = S.CONVERSATIONS_LOCK
    class RevokingLock:
        def __enter__(self):
            real_lock.acquire()
            revoke()
        def __exit__(self, *args):
            real_lock.release()
    monkeypatch.setattr(S, "CONVERSATIONS_LOCK", RevokingLock())
    response = client.get(route)
    assert response.status_code == 401, response.text
    assert "PRIVATE" not in response.text


@pytest.mark.parametrize("route", DATA_ROUTES)
def test_unavailable_security_after_read_is_not_empty_history(history, monkeypatch, route):
    client, _ = history.connect()
    module, name = (search, "_read") if "conversation-search" in route else (S, "load_conversations")
    original = getattr(module, name)
    def read(*args, **kwargs):
        value = original(*args, **kwargs)
        attempts = []
        def security():
            attempts.append(True)
            if len(attempts) == 1:
                raise OSError("PRIVATE security failure")
            return {"enabled": True}
        monkeypatch.setattr(S, "load_pin_config", security)
        return value
    monkeypatch.setattr(module, name, read)
    response = client.get(route)
    assert response.status_code == 503, response.text
    assert "PRIVATE" not in response.text


@pytest.mark.parametrize("boundary", ["message", "search", "settings"])
def test_revocation_during_projection_stops_disclosure(history, monkeypatch, boundary):
    client, revoke = history.connect()
    module, name, route = {
        "message": (ai_routes, "_public_conversation_turn", "/api/ai/conversations/mine"),
        "search": (search, "_match", "/api/intelligence/conversation-search?q=PRIVATE"),
        "settings": (workspace_settings, "public", "/api/ai/conversations/mine/settings"),
    }[boundary]
    original = getattr(module, name)
    calls = []
    def project(*args, **kwargs):
        calls.append(True)
        value = original(*args, **kwargs)
        revoke()
        return value
    monkeypatch.setattr(module, name, project)
    response = client.get(route)
    assert response.status_code == 401, response.text
    assert len(calls) == 1 and "PRIVATE" not in response.text


def test_native_read_survives_unrelated_browser_lock(history, monkeypatch):
    client, _ = history.connect("native")
    browser_token = S.create_session_token("alice")
    original = S.load_conversations
    def read(*args, **kwargs):
        value = original(*args, **kwargs)
        S.revoke_session_token(browser_token)
        return value
    monkeypatch.setattr(S, "load_conversations", read)
    response = client.get("/api/ai/conversations/mine")
    assert response.status_code == 200 and response.json()["id"] == "mine"


def test_local_alias_and_distinct_legacy_projection_are_preserved(history):
    history.seed("local")
    client, _ = history.connect("local")
    assert {row["id"] for row in client.get("/conversations").json()} == {"mine", "peer"}
    assert {row["id"] for row in client.get("/api/ai/conversations").json()["conversations"]} == {"mine", "old"}
    assert {row["id"] for row in client.get("/api/intelligence/conversation-search").json()["items"]} == {"mine", "old"}
    assert client.get("/conversations/mine").json()["compatible"] == {"retained": True}
    projected = client.get("/api/ai/conversations/mine").json()
    assert [row["role"] for row in projected["messages"]] == ["user", "assistant"]
    assert "compatible" not in projected["messages"][0]
    assert client.get("/conversations/old").status_code == 403
    assert client.get("/api/ai/conversations/old").status_code == 200
    assert client.get("/api/ai/conversations/foreign").status_code == 404
    assert client.get("/api/ai/conversations/mine/settings").json()["settings_revision"] == 3


@pytest.mark.parametrize("cursor_wait", ["create", "resume"])
def test_cursor_lock_rechecks_original_access(history, monkeypatch, cursor_wait):
    client, revoke = history.connect()
    url = "/api/intelligence/conversation-search?limit=1"
    # Give the account a second non-peer result without changing existing filters.
    rows = json.loads(history.path.read_text())
    rows["another"] = {**rows["mine"], "id": "another"}
    history.path.write_text(json.dumps(rows))
    if cursor_wait == "resume":
        cursor = client.get(url).json()["next_cursor"]
        assert cursor
        url += "&cursor=" + cursor
    real_lock = search._cursor_lock
    before = dict(search._cursors)
    class RevokingLock:
        def __enter__(self):
            real_lock.acquire()
            revoke()
        def __exit__(self, *args):
            real_lock.release()
    monkeypatch.setattr(search, "_cursor_lock", RevokingLock())
    response = client.get(url)
    assert response.status_code == 401 and "PRIVATE" not in response.text
    assert search._cursors == before


@pytest.mark.parametrize("stage", ["key", "decrypt", "read-error"])
@pytest.mark.parametrize("mode", ["browser", "native"])
def test_search_own_crypto_and_error_boundaries_retain_authority(history, monkeypatch, stage, mode):
    import base64
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    client, revoke = history.connect(mode)
    plaintext = history.path.read_bytes()
    key, nonce = b"k" * 32, b"n" * 12
    history.path.write_text(json.dumps({"_tli_enc": 1,
        "data": base64.b64encode(nonce + AESGCM(key).encrypt(nonce, plaintext, None)).decode()}))
    before = history.path.read_bytes()
    def key_read(name, *, create=False):
        assert name == "conversations_key.bin" and create is False
        if stage == "key":
            revoke()
        return key
    monkeypatch.setattr(S, "_store_key", key_read)
    if stage == "decrypt":
        class RevokingCipher:
            def __init__(self, key):
                self.cipher = AESGCM(key)
            def decrypt(self, *args):
                value = self.cipher.decrypt(*args)
                revoke()
                return value
        monkeypatch.setattr(search, "AESGCM", RevokingCipher)
    elif stage == "read-error":
        original = Path.open
        def fail(path, *args, **kwargs):
            if path == history.path:
                revoke()
                raise OSError("PRIVATE history failure")
            return original(path, *args, **kwargs)
        monkeypatch.setattr(Path, "open", fail)
    response = client.get("/api/intelligence/conversation-search?q=PRIVATE")
    assert response.status_code == 401 and "PRIVATE" not in response.text
    if stage != "read-error":
        assert history.path.read_bytes() == before


def test_native_phone_delete_uses_existing_legacy_contract_without_cross_owner_loss(history, monkeypatch):
    """Exercise the corrected mobile URL; this is not write-authority certification."""
    client, _ = history.connect("native")
    monkeypatch.setattr(S, "save_conversations", history.real_save)
    monkeypatch.setattr(S, "_get_conv_key", lambda: b"k" * 32)
    monkeypatch.setattr(S, "_store_key", lambda *args, **kwargs: b"k" * 32)
    before = history.path.read_bytes()
    assert client.delete("/conversations/foreign").status_code == 403
    assert history.path.read_bytes() == before
    original = json.loads(before)
    deleted = client.delete("/conversations/mine")
    assert deleted.status_code == 200 and deleted.json() == {"ok": True, "existed": True}
    assert S.load_conversations() == {key: value for key, value in original.items() if key != "mine"}
    after = history.path.read_bytes()
    missing = client.delete("/conversations/mine")
    assert missing.status_code == 200 and missing.json() == {"ok": True, "existed": False}
    assert history.path.read_bytes() == after
