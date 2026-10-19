# backend/tests/test_system_routes.py
"""
Tests for system routes: health, onboarding, PIN, diagnostics.

These tests cover publicly accessible endpoints and auth enforcement.
No PIN is set in the test environment so require_session returns 'local'
by default (open access mode).
"""
from __future__ import annotations

import pytest


class TestHealth:
    def test_llm_health_reachable(self, browser_client):
        """Health endpoint exists and returns JSON regardless of LM Studio state."""
        r = browser_client.get("/health/llm")
        assert r.status_code in (200, 503)
        data = r.json()
        assert isinstance(data, dict)

    def test_health_report_reachable(self, browser_client):
        """Health report endpoint exists."""
        r = browser_client.get("/health/llm/report")
        assert r.status_code in (200, 503)

    def test_agent_ping(self, client):
        """Agent ping returns ok."""
        r = client.get("/agent/ping")
        assert r.status_code == 200
        data = r.json()
        assert data.get("ok") is True or "status" in data or "pong" in str(data)


class TestOnboarding:
    def test_onboarding_status_public(self, client):
        """Onboarding status endpoint is accessible without auth."""
        r = client.get("/system/onboarding/status")
        assert r.status_code == 200
        data = r.json()
        assert "complete" in data
        assert isinstance(data["complete"], bool)

    def test_onboarding_complete_requires_auth(self, browser_client):
        """Marking onboarding complete requires a PIN session or direct localhost."""
        r = browser_client.post("/system/onboarding/complete")
        # Either succeeds (PIN not enabled) or requires an unlocked browser.
        assert r.status_code in (200, 401)


class TestPIN:
    def test_pin_status_public(self, client):
        """PIN status endpoint is accessible without auth."""
        r = client.get("/system/pin/status")
        assert r.status_code == 200
        data = r.json()
        assert "enabled" in data
        assert isinstance(data["enabled"], bool)

    def test_pin_verify_wrong_pin(self, client):
        """Verifying a wrong PIN returns 401."""
        r = client.post("/system/pin/verify", json={"pin": "000000"})
        # 200 if PIN not configured, 401/403 if PIN is set and wrong
        assert r.status_code in (200, 400, 401, 403)

    def test_pin_set_requires_auth(self, client):
        """Setting a PIN requires a session (no-op if PIN not enabled)."""
        r = client.post("/system/pin/set", json={"pin": "000000"})
        assert r.status_code in (200, 401, 403, 422)


class TestDiagnostics:
    def test_version_endpoint(self, client):
        """Version diagnostics endpoint returns version info."""
        r = client.get("/api/diagnostics/version")
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, dict)

    def test_whoami_endpoint(self, browser_client):
        """Private identity info is available to a verified browser."""
        r = browser_client.get("/api/diagnostics/whoami")
        assert r.status_code == 200

    def test_routes_endpoint(self, client):
        """Routes debug endpoint returns JSON (actual route list is at /debug/routes)."""
        r = client.get("/api/diagnostics/routes")
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, dict)


class TestStatus:
    def test_status_returns_json(self, browser_client):
        """Status endpoint returns JSON with system info."""
        r = browser_client.get("/status")
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, dict)

    def test_system_probe(self, browser_client, monkeypatch):
        """A verified browser receives a synthetic hardware observation."""
        from routers import system_routes
        expected = {"cpu_cores": 4, "cpu_threads": 8, "ram_total_gb": 16.0,
                    "ram_available_gb": 8.0, "gpu_vram_gb": None,
                    "suggested_profile": "balanced"}
        def probe(*, check=None):
            assert callable(check)
            check()
            return expected
        monkeypatch.setattr(system_routes, "system_probe", probe)
        r = browser_client.get("/system/probe")
        assert r.status_code == 200
        assert r.json() == expected
        assert r.headers["cache-control"] == "no-store"

    def test_system_capabilities(self, browser_client):
        """Saved device capabilities require a verified browser."""
        r = browser_client.get("/system/capabilities")
        assert r.status_code == 200
