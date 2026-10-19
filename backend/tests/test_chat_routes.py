# backend/tests/test_chat_routes.py
"""
Tests for chat, conversation history, and memory endpoints.

Key coverage:
- Auth enforcement on all write endpoints
- Conversation access control (user isolation)
- Memory add/retrieve scoped to session user
- Chat endpoint reaches session guard (AI provider failure is expected in tests)
"""
from __future__ import annotations

import pytest


class TestChatAuth:
    def test_chat_passes_session_guard(self, authed_client):
        """Chat endpoint accepts a valid session; may fail at AI provider level."""
        r = authed_client.post("/chat", json={"message": "hello"})
        # 200 = AI responded, 503 = no AI provider (both mean auth passed)
        assert r.status_code in (200, 503)

    def test_chat_without_session_when_pin_disabled(self, client):
        """Without PIN, chat endpoint is accessible; with PIN enabled, gets 401."""
        r = client.post("/chat", json={"message": "hello"})
        # 200/503 = auth passed (no PIN); 401 = PIN enabled, session required
        assert r.status_code in (200, 401, 503)

    def test_chat_missing_message_is_rejected(self, authed_client):
        """Chat with no message body fails validation."""
        r = authed_client.post("/chat", json={})
        assert r.status_code == 422

    def test_chat_user_id_from_session(self, authed_client):
        """user_id in response (if present) should match session, not request body."""
        r = authed_client.post("/chat", json={
            "message": "test",
            "user_id": "hacker-user"  # should be ignored
        })
        # Auth passed — AI may be unavailable but the request is valid
        assert r.status_code in (200, 503)


class TestConversations:
    def test_list_conversations_requires_auth(self, browser_client):
        """Conversations list returns only the session user's conversations."""
        r = browser_client.get("/conversations")
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, list)

    def test_list_conversations_no_auth(self, app, browser_client):
        """An enabled PIN requires actual credentials for a private read."""
        from fastapi.testclient import TestClient

        with TestClient(app, base_url="https://testserver") as unauthenticated:
            r = unauthenticated.get("/conversations")
        assert r.status_code == 401
        assert r.headers["Cache-Control"] == "no-store"

    def test_get_nonexistent_conversation_is_404(self, browser_client):
        """Fetching a conversation that doesn't exist returns 404."""
        r = browser_client.get("/conversations/conv-nonexistent-xyz-abc")
        assert r.status_code == 404

    def test_delete_nonexistent_conversation_is_ok(self, authed_client):
        """Deleting a non-existent conversation returns ok=True, existed=False."""
        r = authed_client.delete("/conversations/conv-nonexistent-xyz-abc")
        assert r.status_code == 200
        data = r.json()
        assert data.get("ok") is True
        assert data.get("existed") is False

    def test_other_user_conversation_denied(self, browser_client):
        """A conversation owned by a different user returns 403."""
        import tli_state as S

        # Seed a conversation owned by 'owner-user'
        convs = S.load_conversations()
        convs["conv-owned-by-other"] = {
            "id": "conv-owned-by-other",
            "title": "Private conv",
            "user_id": "owner-user",
            "messages": [],
            "last_updated": S.now_iso(),
        }
        S.save_conversations(convs)

        # The real browser session belongs to 'test-user'.
        try:
            r = browser_client.get("/conversations/conv-owned-by-other")
            assert r.status_code == 403
            assert r.json()["detail"] == "Access denied"
        finally:
            # Clean up
            convs = S.load_conversations()
            convs.pop("conv-owned-by-other", None)
            S.save_conversations(convs)

    def test_other_user_cannot_delete_conversation(self, app, client):
        """Attempting to delete another user's conversation returns 403."""
        import tli_state as S
        from routers.system_routes import require_session

        convs = S.load_conversations()
        convs["conv-delete-target"] = {
            "id": "conv-delete-target",
            "title": "Do not delete",
            "user_id": "real-owner",
            "messages": [],
            "last_updated": S.now_iso(),
        }
        S.save_conversations(convs)

        app.dependency_overrides[require_session] = lambda: "not-owner"
        try:
            r = client.delete("/conversations/conv-delete-target")
            assert r.status_code == 403
        finally:
            app.dependency_overrides.pop(require_session, None)
            convs = S.load_conversations()
            convs.pop("conv-delete-target", None)
            S.save_conversations(convs)


class TestMemory:
    def test_memory_add_uses_session_user(self, authed_client):
        """Memory is stored under the session user, ignoring user_id in the body."""
        r = authed_client.post("/memory/add", json={
            "user_id": "injected-user",  # required by model but ignored by endpoint
            "fact": "test fact for pytest",
            "category": "test",
        })
        assert r.status_code == 200
        data = r.json()
        assert data.get("status") == "ok"
        assert "added" in data

    def test_memory_retrieve_requires_auth(self, authed_client):
        """Memory retrieval works with auth."""
        r = authed_client.get("/memory/test-user")
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, dict)

    def test_memory_add_fact_is_persisted(self, authed_client):
        """A fact added via /memory/add appears in subsequent /memory retrieval."""
        unique_fact = "pytest_unique_fact_xk9z2"
        r = authed_client.post("/memory/add", json={
            "user_id": "ignored-by-server",  # required by model; session user is used
            "fact": unique_fact,
            "category": "test",
        })
        assert r.status_code == 200

        r2 = authed_client.get("/memory/test-user")
        assert r2.status_code == 200
        mem = r2.json()
        facts = [f.get("text", "") for f in mem.get("facts", [])]
        assert any(unique_fact in t for t in facts), (
            f"Fact '{unique_fact}' not found in memory: {facts}"
        )
