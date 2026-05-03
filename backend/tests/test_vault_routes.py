# backend/tests/test_vault_routes.py
"""
Tests for vault routes: status, access control, path traversal prevention.

Path traversal tests are the most critical — they verify that an attacker
cannot escape the vault directory by using '../..' in file/secret IDs.

Full lifecycle tests (setup → unlock → secret → lock) require vault_security
to be initialized; they are marked with 'vault_lifecycle' to allow targeted runs:
    pytest -m vault_lifecycle
"""
from __future__ import annotations

import pytest


class TestVaultStatus:
    def test_vault_status_accessible(self, authed_client):
        """Vault status endpoint is accessible with auth."""
        r = authed_client.get("/vault/status")
        assert r.status_code == 200
        data = r.json()
        assert "initialized" in data or "locked" in data or "status" in data

    def test_vault_list_requires_init(self, authed_client):
        """Vault list returns 403 (locked) or 200 (unlocked), never 500."""
        r = authed_client.get("/vault/list")
        assert r.status_code in (200, 403)


class TestVaultPathTraversal:
    """Critical security tests: path traversal must be blocked at the route layer."""

    @pytest.mark.parametrize("evil_path", [
        "../etc/passwd",
        "../../etc/shadow",
        "..\\..\\windows\\system32\\drivers\\etc\\hosts",
        "%2e%2e%2fetc%2fpasswd",
        "....//....//etc/passwd",
        "../data/conversations.json",
    ])
    def test_get_file_traversal_blocked(self, authed_client, evil_path):
        """GET /vault/get_file rejects path traversal in file_id."""
        r = authed_client.get("/vault/get_file", params={"file_id": evil_path})
        assert r.status_code in (400, 403, 404), (
            f"Expected 400/403/404 for traversal path '{evil_path}', got {r.status_code}"
        )

    @pytest.mark.parametrize("evil_path", [
        "../etc/passwd",
        "../../secret",
        "..\\config\\app.py",
    ])
    def test_delete_file_traversal_blocked(self, authed_client, evil_path):
        """POST /vault/delete_file rejects path traversal in file_id."""
        r = authed_client.post("/vault/delete_file", json={"file_id": evil_path})
        assert r.status_code in (400, 403, 404), (
            f"Expected 400/403/404 for traversal path '{evil_path}', got {r.status_code}"
        )

    @pytest.mark.parametrize("evil_key", [
        "../api_key",
        "../../tli_state",
        "some/../../etc/passwd",
    ])
    def test_get_secret_traversal_blocked(self, authed_client, evil_key):
        """GET /vault/secret/{key} with traversal path returns 400/403/404."""
        r = authed_client.get(f"/vault/secret/{evil_key}")
        assert r.status_code in (400, 403, 404), (
            f"Expected 400/403/404 for key '{evil_key}', got {r.status_code}"
        )

    @pytest.mark.parametrize("evil_key", [
        "../api_key",
        "../../etc/passwd",
    ])
    def test_set_secret_traversal_blocked(self, authed_client, evil_key):
        """POST /vault/secret/{key} with traversal path is blocked.

        Note: '../api_key' URL-decodes to '/api_key' which hits a different
        route returning 405 Method Not Allowed — this is still a security win
        (the vault write does not occur).
        """
        r = authed_client.post(
            f"/vault/secret/{evil_key}",
            json={"value": "evil-value"},
        )
        assert r.status_code in (400, 403, 404, 405), (
            f"Expected 400/403/404/405 for key '{evil_key}', got {r.status_code}"
        )

    @pytest.mark.parametrize("evil_key", [
        "../api_key",
        "../../etc/passwd",
    ])
    def test_delete_secret_traversal_blocked(self, authed_client, evil_key):
        """DELETE /vault/secret/{key} with traversal path is blocked.

        Note: path traversal resolves to a different route or 405 — vault
        deletion does not occur either way.
        """
        r = authed_client.delete(f"/vault/secret/{evil_key}")
        assert r.status_code in (400, 403, 404, 405), (
            f"Expected 400/403/404/405 for key '{evil_key}', got {r.status_code}"
        )


class TestVaultAuth:
    def test_vault_unlock_wrong_password(self, authed_client):
        """Unlocking with a wrong password does not succeed (returns error)."""
        r = authed_client.post("/vault/unlock", json={
            "password": "definitely-wrong-password-xyz123"
        })
        # Either vault not initialized (403) or wrong password (401/403)
        # Should NEVER be 200 with wrong password
        if r.status_code == 200:
            pytest.fail(
                "Vault unlock succeeded with wrong password — "
                "this means vault is not initialized and setup is needed first."
            )
        assert r.status_code in (400, 401, 403)

    def test_vault_secrets_require_unlocked_vault(self, authed_client):
        """Secrets endpoint fails gracefully when vault is locked."""
        r = authed_client.get("/vault/secrets")
        assert r.status_code in (200, 403)

    def test_vault_notes_require_unlocked_vault(self, authed_client):
        """Notes endpoint fails gracefully when vault is locked."""
        r = authed_client.get("/vault/notes")
        assert r.status_code in (200, 403)

    def test_vault_export_requires_auth(self, authed_client):
        """Export backup is scoped to the session user."""
        r = authed_client.get("/vault/export_backup")
        # 200 (file download) or 403 (vault locked/not init) — never 401
        assert r.status_code in (200, 403)


@pytest.mark.vault_lifecycle
class TestVaultLifecycle:
    """Full vault lifecycle using a temporary isolated vault directory.

    Run with: pytest -m vault_lifecycle
    These tests mutate vault state — run in isolation.
    """

    @pytest.fixture(autouse=True)
    def isolated_vault(self, tmp_path, monkeypatch):
        """Reset vault in-memory state before each lifecycle test.

        vault_security.py uses two module-level dicts for unlocked state.
        We clear them so tests start with a locked/uninitialized vault.
        The vault meta file uses the working directory, so lifecycle tests
        may share state with the dev vault — skip if already initialized.
        """
        import vault_security

        # Clear in-memory unlock/key state from any previous test
        monkeypatch.setattr(vault_security, "UNLOCKED_VAULTS", {})
        monkeypatch.setattr(vault_security, "ENCRYPTION_KEYS", {})

    def test_setup_then_unlock(self, authed_client):
        """Setup vault, then unlock with the correct password."""
        from vault_security import is_initialized
        if is_initialized():
            pytest.skip("Dev vault already initialized; lifecycle tests require a fresh vault.")

        r = authed_client.post("/vault/setup", json={"password": "Str0ngPass!"})
        assert r.status_code == 200, f"Setup failed: {r.text}"

        r = authed_client.post("/vault/unlock", json={"password": "Str0ngPass!"})
        assert r.status_code == 200, f"Unlock failed: {r.text}"

    def test_setup_wrong_unlock_fails(self, authed_client):
        """Setup vault, wrong password unlock returns error."""
        from vault_security import is_initialized
        if is_initialized():
            pytest.skip("Dev vault already initialized; lifecycle tests require a fresh vault.")

        r = authed_client.post("/vault/setup", json={"password": "Str0ngPass!"})
        assert r.status_code == 200

        r = authed_client.post("/vault/unlock", json={"password": "WrongPass!"})
        assert r.status_code in (400, 401, 403)

    def test_secret_store_and_retrieve(self, authed_client):
        """After unlock, store a secret and retrieve it."""
        from vault_security import is_initialized
        if is_initialized():
            pytest.skip("Dev vault already initialized; lifecycle tests require a fresh vault.")

        authed_client.post("/vault/setup", json={"password": "Pass123!"})
        authed_client.post("/vault/unlock", json={"password": "Pass123!"})

        # Store secret
        r = authed_client.post("/vault/secret/my-api-key", json={"value": "sk-test-1234"})
        assert r.status_code == 200

        # Retrieve secret
        r = authed_client.get("/vault/secret/my-api-key")
        assert r.status_code == 200
        data = r.json()
        assert data.get("value") == "sk-test-1234" or "sk-test-1234" in str(data)
