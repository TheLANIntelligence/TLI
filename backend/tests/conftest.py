# backend/tests/conftest.py
"""
Shared fixtures for TLI backend tests.

Import order matters: sys.path must be set before any TLI imports,
so that 'from main import app' resolves correctly when running pytest
from inside the backend/ directory.
"""
from __future__ import annotations

import sys
import os
import tempfile
import threading
from pathlib import Path

# Ensure backend/ is importable as a root package
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest
from fastapi.testclient import TestClient

# Establish isolation during collection, before test modules import the app/state.
# TLI_ROOT is an existing installation boundary; never use the developer's data.
_isolation = pytest.MonkeyPatch()
TEST_ROOT = Path(tempfile.mkdtemp(prefix="tli-tests-")).resolve()
_isolation.setenv("TLI_ROOT", str(TEST_ROOT))
_isolation.chdir(TEST_ROOT)  # legacy relative stores (notably vault_meta.json)

import tli_state as S
S.FRONTEND_DIR = str(Path(__file__).resolve().parents[2] / "frontend")
S.ASSETS_DIR = str(Path(S.FRONTEND_DIR) / "assets")

from ai import ai_manager
from ai import runtime_support
_isolation.setattr(runtime_support, "runtime_info", lambda path: {
    "build": None, "flags": None, "reason": "Runtime probes disabled in isolated tests."})
_test_ai = TEST_ROOT / "backend" / "ai"
_test_ai.mkdir(parents=True)
_isolation.setattr(ai_manager, "_ai_base_dir", lambda: _test_ai)
for _name in ("AI_DIR", "ACTIVE_MODEL_PATH", "_STORAGE_CONFIG_PATH"):
    _old = getattr(ai_manager, _name)
    _isolation.setattr(ai_manager, _name, _test_ai if _name == "AI_DIR" else _test_ai / _old.name)
_isolation.setattr(ai_manager.BundledAIManager, "ensure_running", lambda self: False)
_isolation.setattr(ai_manager.BundledAIManager, "is_healthy", lambda self: False)
_isolation.setattr(ai_manager.BundledAIManager, "stop", lambda self: None)

import requests
import urllib.request
import httpx

def _no_network(*args, **kwargs):
    raise requests.ConnectionError("Live network disabled in isolated tests")

_isolation.setattr(requests.sessions.Session, "request", _no_network)
_isolation.setattr(urllib.request, "urlopen", _no_network)
_isolation.setattr(ai_manager, "urlopen", _no_network)
_isolation.setattr(httpx.HTTPTransport, "handle_request", _no_network)
async def _no_async_network(*args, **kwargs):
    return _no_network()
_isolation.setattr(httpx.AsyncHTTPTransport, "handle_async_request", _no_async_network)

# Older modules start workers during import. Suppress only that bootstrap window;
# test threads and TestClient's event loop remain real after the import completes.
with pytest.MonkeyPatch.context() as _bootstrap:
    _bootstrap.setattr(threading.Thread, "start", lambda self: None)
    import main as _main

# The reviewed peer transport uses raw http.client with certificate pinning.
# No test may accidentally contact a LAN computer; explicit loopback tests
# replace this boundary locally using a synthetic server/certificate.
import peer_trust as _peer_trust
_isolation.setattr(_peer_trust, "_exchange", _no_network)
_isolation.setattr(_peer_trust, "_stream_exchange", _no_network)
import lan_inference as _lan_inference
_isolation.setattr(_lan_inference, "_local_response", _no_network)

from routers import printers
_isolation.setattr(printers, "SNMP_CFG_PATH", TEST_ROOT / "printers_snmp.json")
from routers import file_routes
def _no_real_trash(*args, **kwargs):
    raise RuntimeError("Real Trash operations are disabled in isolated tests")
_isolation.setattr(file_routes, "send2trash", _no_real_trash)


@pytest.fixture(autouse=True)
def isolated_background_services(monkeypatch):
    """Lifecycle tests exercise wiring without touching LAN, disks, or models."""
    monkeypatch.setattr(_main, "start_background_loops", lambda: None)
    monkeypatch.setattr(_main, "_cleanup_start", lambda: None)
    monkeypatch.setattr(_main, "_cleanup_stop", lambda: None)
    monkeypatch.setattr(_main.lan_discovery, "start", lambda: None)
    monkeypatch.setattr(_main.lan_discovery, "stop", lambda: None)
    async def no_ambient():
        return
    monkeypatch.setattr(_main, "run_ambient_loop", no_ambient)


def pytest_unconfigure(config):
    _isolation.undo()


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
