"""Effective host mounting for administrative routes, without host lifespan."""
from unittest.mock import Mock

from fastapi.testclient import TestClient
import pytest

import license as licensing
import tli_state as S
from routers import satellite_routes


PRIVATE_ROUTES = [
    ("GET", "/license/details", None),
    ("POST", "/license/activate", {"key": "synthetic-key"}),
    ("DELETE", "/license/deactivate", None),
    ("POST", "/mesh/satellite/generate-token", None),
    ("GET", "/mesh/satellite/list", None),
    ("DELETE", "/mesh/satellite/sat_fixture", None),
]


@pytest.mark.parametrize("method,route,body", PRIVATE_ROUTES)
@pytest.mark.parametrize("mode", ["anonymous", "cross-origin"])
def test_main_mount_preserves_administrative_browser_boundary(app, tmp_path, monkeypatch, method, route, body, mode):
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    monkeypatch.setattr(S, "LICENSE_FILE", tmp_path / "license.json")
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    sensitive = Mock(side_effect=AssertionError("Denied administrative request reached private work"))
    monkeypatch.setattr(S, "load_node_config", sensitive)
    monkeypatch.setattr(S, "load_license", sensitive)
    monkeypatch.setattr(licensing, "validate_key", sensitive)
    monkeypatch.setattr(satellite_routes, "_load_reg", sensitive)
    monkeypatch.setattr(satellite_routes, "_make_qr_data_uri", sensitive)
    headers = {"Origin": "http://localhost:8000"}
    if mode == "cross-origin":
        headers.update(Origin="https://unrelated.invalid", Cookie="tli_session=" + S.create_session_token("owner"))
    browser = TestClient(app, base_url="http://localhost:8000", client=("127.0.0.1", 1234), headers=headers)
    try:
        response = browser.request(method, route, **({"json": body} if body else {}))
    finally:
        browser.close()
    assert response.status_code == (401 if mode == "anonymous" else 403), response.text
    assert response.headers["cache-control"] == "no-store"
    sensitive.assert_not_called()
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("beta", [False, True])
def test_main_public_license_bootstrap_never_projects_private_identity(app, monkeypatch, beta):
    monkeypatch.setattr(licensing, "BETA_MODE", beta)
    monkeypatch.setattr(licensing, "get_status", lambda: {
        "tier": "pro", "valid": True, "licensee": "PRIVATE NAME", "issued_at": "PRIVATE DATE",
        "expires_at": "PRIVATE EXPIRY", "node_bound": True,
    })
    monkeypatch.setattr(licensing, "get_active_tier", lambda: "pro")
    private = Mock(side_effect=AssertionError("Public bootstrap read node or license files"))
    monkeypatch.setattr(S, "load_license", private)
    monkeypatch.setattr(S, "load_node_config", private)
    browser = TestClient(app, base_url="http://localhost:8000", client=("127.0.0.1", 1234))
    try:
        response = browser.get("/license/status")
    finally:
        browser.close()
    assert response.status_code == 200, response.text
    assert set(response.json()) == {"tier", "valid", "beta", "features"}
    assert response.json()["beta"] is beta and "PRIVATE" not in response.text
    private.assert_not_called()
