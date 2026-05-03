# backend/tests/conftest.py
"""
Shared fixtures for TLI backend tests.

Import order matters: sys.path must be set before any TLI imports,
so that 'from main import app' resolves correctly when running pytest
from inside the backend/ directory.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Ensure backend/ is importable as a root package
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="session")
def app():
    """Import and return the FastAPI app (once per test session)."""
    from main import app as _app  # heavy import: providers, routers, etc.
    return _app


@pytest.fixture(scope="session")
def client(app):
    """Session-scoped TestClient — no startup/shutdown events fired."""
    return TestClient(app, raise_server_exceptions=False)


@pytest.fixture()
def authed_client(app, client):
    """Function-scoped: overrides require_session to return 'test-user'.

    Restores dependency_overrides after each test so tests don't bleed
    into each other.
    """
    from routers.system_routes import require_session

    app.dependency_overrides[require_session] = lambda: "test-user"
    try:
        yield client
    finally:
        app.dependency_overrides.pop(require_session, None)
