"""Effective host mounting and private validation; no host lifespan or probes."""
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi.testclient import TestClient
import pytest

import model_probe
import tli_state as S
from routers import system_routes as routes

READS = ["/health/llm", "/health/llm/report", "/health/lmstudio/report",
         "/models/available", "/setup/autodetect"]
WRITES = ["/system/lm_studio/test", "/system/lm_studio/url"]


@pytest.fixture
def mounted(app, tmp_path, monkeypatch):
    monkeypatch.setattr(S, "_active_sessions", {})
    monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": True})
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    token = S.create_session_token("owner")
    denied = Mock(side_effect=AssertionError("Denied endpoint reached private work"))
    monkeypatch.setattr(S, "lm_provider", SimpleNamespace(health_check=denied, health_report=denied,
                                                       list_models=denied, models_url="http://unused.invalid"))
    monkeypatch.setattr(S, "save_lm_studio_url", denied)
    monkeypatch.setattr(S, "load_shelly_registry", denied)
    monkeypatch.setattr(S, "load_node_config", denied)
    monkeypatch.setattr(S, "read_node_config", denied)
    monkeypatch.setattr(model_probe, "probe_json", denied)
    monkeypatch.setattr(routes, "_probe_lm", denied)
    clients = []
    def client(cookie=True, origin="https://host.test"):
        browser = TestClient(app, base_url="https://host.test", client=("192.0.2.4", 1234),
                             headers={"Origin": origin},
                             cookies={"tli_session": token} if cookie else {})
        clients.append(browser)
        return browser
    yield SimpleNamespace(client=client, denied=denied, root=tmp_path)
    for browser in clients:
        browser.close()


@pytest.mark.parametrize("path", READS + WRITES)
@pytest.mark.parametrize("mode", ["anonymous", "foreign-origin"])
def test_effective_model_routes_deny_before_private_work(mounted, path, mode):
    browser = mounted.client(cookie=mode != "anonymous",
                             origin="https://other.invalid" if mode == "foreign-origin" else "https://host.test")
    response = browser.post(path, json={"url": "http://127.0.0.1:1234/v1"}) if path in WRITES else browser.get(path)
    assert response.status_code == (401 if mode == "anonymous" else 403), response.text
    assert response.headers["cache-control"] == "no-store"
    mounted.denied.assert_not_called()
    assert not list(mounted.root.iterdir())


@pytest.mark.parametrize("path", WRITES)
@pytest.mark.parametrize("payload", [{"url": {"PRIVATE": "secret-input"}}, {"url": ["PRIVATE secret-input"]},
                                      {"url": "PRIVATE" * 5000}, {}], ids=["object", "list", "oversized", "missing"])
def test_model_validation_never_echoes_endpoint_input(mounted, path, payload):
    response = mounted.client().post(path, json=payload)
    assert response.status_code == 422, response.text
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {"detail": "Provide valid bounded model endpoint fields."}
    mounted.denied.assert_not_called()


@pytest.mark.parametrize("path", WRITES)
def test_model_invalid_json_is_private_generic_error(mounted, path):
    response = mounted.client().post(path, content=b'{"url":"PRIVATE', headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    assert response.headers["cache-control"] == "no-store"
    assert "PRIVATE" not in response.text and "input" not in response.json()
    mounted.denied.assert_not_called()
