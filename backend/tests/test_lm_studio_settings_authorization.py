"""Captured browser authority around synthetic LM Studio tests and temp saves."""
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import lm_studio_config as config
import model_probe
import tli_state as S
from providers.lmstudio import LMStudioProvider
from routers import system_routes as routes


PATHS = ["/system/lm_studio/test", "/system/lm_studio/url"]
OLD = {"chat_url": "https://old.invalid/v1/chat/completions", "models_url": "https://old.invalid/v1/models"}
NEW = {"chat_url": "http://192.0.2.25:4321/v1/chat/completions", "models_url": "http://192.0.2.25:4321/v1/models"}


@pytest.fixture
def studio(tmp_path, monkeypatch):
    monkeypatch.setattr(S, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(S, "PIN_CONFIG_FILE", tmp_path / "pin.json")
    monkeypatch.setattr(S, "_active_sessions", {})
    S.save_pin_config("a" * 64, "b" * 64)
    path = config.config_path(tmp_path)
    path.write_text(json.dumps({**OLD, "future": {"retain": [1, True, None]}}))
    provider = LMStudioProvider(**OLD)
    provider._report_cache = {"ts": 10**12, "report": {"ok": True}}
    monkeypatch.setattr(S, "lm_provider", provider)
    monkeypatch.setattr(S, "LM_STUDIO_URL", OLD["chat_url"])
    monkeypatch.setattr(S, "LM_STUDIO_MODELS_URL", OLD["models_url"])
    log = Mock(); monkeypatch.setattr(S, "log_debug", log)
    response = SimpleNamespace(status_code=200, headers={}, close=Mock(),
                               iter_content=Mock(return_value=iter([b'{"data":[{"id":"PRIVATE model"}]}'])))
    session = SimpleNamespace(trust_env=True, get=Mock(return_value=response))
    class Session:
        def __enter__(self): return session
        def __exit__(self, *args): pass
    factory = Mock(side_effect=Session)
    monkeypatch.setattr(model_probe.requests, "Session", factory)
    app = FastAPI(); app.include_router(routes.router)
    clients = []
    def browser(mode="pin-local"):
        local = mode not in {"pin-https", "pin-off-lan", "remote-http"}
        origin = "http://localhost:8000" if local else ("http" if mode == "remote-http" else "https") + "://192.0.2.5:8443"
        if mode in {"open-local", "pin-off-lan"}:
            monkeypatch.setattr(S, "load_pin_config", lambda: {"enabled": False})
        client = TestClient(app, base_url=origin, client=("127.0.0.1" if local else "192.0.2.8", 40000),
                            headers={"Origin": origin}, raise_server_exceptions=False)
        token = None if mode in {"anonymous", "open-local", "pin-off-lan"} else S.create_session_token("owner")
        if token: client.headers["Cookie"] = "tli_session=" + token
        if mode == "revoked": S.revoke_session_token(token)
        if mode == "expired": S._active_sessions[token]["expiry"] = 0
        if mode == "cross-origin": client.headers["Origin"] = "https://unrelated.invalid"
        if mode == "same-site": client.headers["Sec-Fetch-Site"] = "same-site"
        if mode == "missing-origin": del client.headers["Origin"]
        if mode == "proxy": client.headers["X-Forwarded-For"] = "127.0.0.1"
        if mode == "peer": client.headers["X-TLI-Peer-Signature"] = "synthetic"
        if mode == "bearer": client.headers["Authorization"] = "Bearer paired-device-credential"
        clients.append(client)
        return client, token
    def lose(token, kind="revoke"):
        if kind == "revoke": S.revoke_session_token(token)
        else:
            def fail(): raise HTTPException(503, "Security configuration unavailable")
            monkeypatch.setattr(S, "load_pin_config", fail)
    yield SimpleNamespace(path=path, provider=provider, log=log, browser=browser, lose=lose,
                          session=session, response=response, factory=factory)
    for client in clients: client.close()


def assert_old(studio, before):
    assert studio.path.read_bytes() == before and S.lm_provider is studio.provider
    assert (S.LM_STUDIO_URL, S.LM_STUDIO_MODELS_URL) == (OLD["chat_url"], OLD["models_url"])
    assert not list(studio.path.parent.glob(".lm-studio-*"))


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("mode", ["anonymous", "pin-off-lan", "revoked", "expired", "cross-origin", "same-site",
                                  "missing-origin", "proxy", "peer", "bearer", "remote-http"])
def test_denied_requests_never_read_config_construct_provider_or_send_probe(studio, monkeypatch, path, mode):
    client, _ = studio.browser(mode); before = studio.path.read_bytes()
    read = Mock(side_effect=AssertionError("No private read")); constructor = Mock()
    monkeypatch.setattr(config, "_read_snapshot", read); monkeypatch.setattr(S, "_new_lm_studio_provider", constructor)
    result = client.post(path, json={"url": NEW["chat_url"]})
    assert result.status_code == (401 if mode in {"anonymous", "revoked", "expired"} else 403), result.text
    assert result.headers["cache-control"] == "no-store"
    read.assert_not_called(); constructor.assert_not_called(); studio.factory.assert_not_called()
    assert_old(studio, before)


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("mode", ["open-local", "pin-local", "pin-https"])
def test_supported_browser_contract_and_selection_preserved(studio, path, mode):
    client, _ = studio.browser(mode); before = studio.path.read_bytes()
    selection, key = S.MODEL_CONFIG, S.DEFAULT_MODEL_KEY
    result = client.post(path, json={"url": NEW["chat_url"]})
    assert result.status_code == 200 and result.headers["cache-control"] == "no-store", result.text
    if path.endswith("/test"):
        assert result.json() == {"ok": True, "models": ["PRIVATE model"], "count": 1}
        assert_old(studio, before)
        assert studio.session.trust_env is False
        assert studio.session.get.call_args.args == (NEW["models_url"],)
        assert studio.session.get.call_args.kwargs["allow_redirects"] is False
        assert studio.session.get.call_args.kwargs["stream"] is True
        assert studio.session.get.call_args.kwargs["headers"] == {"Accept": "application/json"}
        studio.response.close.assert_called_once()
    else:
        assert result.json() == {"ok": True, **NEW}
        assert json.loads(studio.path.read_bytes()) == {**NEW, "future": {"retain": [1, True, None]}}
        assert S.lm_provider is not studio.provider and S.lm_provider._report_cache == {"ts": 0.0, "report": None}
        assert (S.lm_provider.chat_url, S.lm_provider.models_url) == (S.LM_STUDIO_URL, S.LM_STUDIO_MODELS_URL)
        studio.factory.assert_not_called()
    assert S.MODEL_CONFIG is selection and S.DEFAULT_MODEL_KEY == key


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("url", ["", "file:///PRIVATE", "http://user:PRIVATE@model.invalid", "http://model.invalid?PRIVATE=key",
                                 "http://model.invalid/#PRIVATE", "http://model.invalid/\ud800", "http://model.invalid/" + "é" * 2050],
                         ids=["empty", "scheme", "userinfo", "query", "fragment", "surrogate", "utf8-limit"])
def test_invalid_endpoint_is_rejected_before_private_work(studio, path, url):
    client, _ = studio.browser(); before = studio.path.read_bytes()
    # Escaped surrogate JSON remains a malformed URL test, not a client encoder error.
    result = client.post(path, content=json.dumps({"url": url}), headers={"Content-Type": "application/json"})
    assert result.status_code == (422 if "\ud800" in url else 400) and "PRIVATE" not in result.text
    assert result.headers["cache-control"] == "no-store"
    studio.factory.assert_not_called(); assert_old(studio, before)


def test_internal_url_validation_rejects_unpaired_unicode_before_serialization():
    with pytest.raises(config.InvalidEndpoint):
        config.from_url("http://model.invalid/\ud800")


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("body", [{}, {"url": ["PRIVATE"]}, {"url": "PRIVATE" * 700}], ids=["missing", "type", "oversized"])
def test_invalid_body_is_generic_and_uncached(studio, path, body):
    client, _ = studio.browser(); before = studio.path.read_bytes()
    result = client.post(path, json=body)
    assert result.status_code == 422 and "PRIVATE" not in result.text
    assert result.headers["cache-control"] == "no-store"
    studio.factory.assert_not_called(); assert_old(studio, before)


@pytest.mark.parametrize("phase", ["read", "validate", "construct", "fsync", "final-read"])
@pytest.mark.parametrize("kind,status", [("revoke", 401), ("security-unavailable", 503)])
def test_save_revocation_before_commit_preserves_original_and_runtime(studio, monkeypatch, phase, kind, status):
    client, token = studio.browser(); before = studio.path.read_bytes()
    def lose(): studio.lose(token, kind)
    if phase == "validate":
        original = config.from_url
        def wrapped(value): result = original(value); lose(); return result
        monkeypatch.setattr(config, "from_url", wrapped)
    elif phase == "construct":
        original = S._new_lm_studio_provider
        def wrapped(value): result = original(value); lose(); return result
        monkeypatch.setattr(S, "_new_lm_studio_provider", wrapped)
    elif phase == "fsync":
        original = config.os.fsync
        def wrapped(fd): original(fd); lose()
        monkeypatch.setattr(config.os, "fsync", wrapped)
    else:
        original = config._read_snapshot; calls = []
        def wrapped(*args, **kwargs):
            result = original(*args, **kwargs); calls.append(True)
            if len(calls) == (1 if phase == "read" else 3): lose()
            return result
        monkeypatch.setattr(config, "_read_snapshot", wrapped)
    result = client.post(PATHS[1], json={"url": NEW["chat_url"]})
    assert result.status_code == status and "PRIVATE" not in result.text
    assert_old(studio, before); studio.log.assert_not_called(); studio.factory.assert_not_called()


@pytest.mark.parametrize("phase", ["replace", "publish", "log"])
@pytest.mark.parametrize("kind,status", [("revoke", 401), ("security-unavailable", 503)])
def test_confirmed_save_publishes_runtime_before_denied_disclosure(studio, monkeypatch, phase, kind, status):
    client, token = studio.browser()
    def lose(): studio.lose(token, kind)
    if phase == "replace":
        original = config.os.replace
        def wrapped(*args): original(*args); lose()
        monkeypatch.setattr(config.os, "replace", wrapped)
    elif phase == "publish":
        original = S._publish_lm_studio
        def wrapped(*args): original(*args); lose()
        monkeypatch.setattr(S, "_publish_lm_studio", wrapped)
    else: studio.log.side_effect = lambda *args, **kwargs: lose()
    result = client.post(PATHS[1], json={"url": NEW["chat_url"]})
    assert result.status_code == status and "chat_url" not in result.text
    assert config.read(studio.path.parent) == NEW
    assert S.lm_provider is not studio.provider
    assert (S.LM_STUDIO_URL, S.lm_provider.chat_url, S.LM_STUDIO_MODELS_URL, S.lm_provider.models_url) == (
        NEW["chat_url"], NEW["chat_url"], NEW["models_url"], NEW["models_url"])
    assert not list(studio.path.parent.glob(".lm-studio-*"))


def test_save_waiting_for_config_lock_rechecks_before_private_read(studio, monkeypatch):
    client, token = studio.browser(); entered = Event(); original = config.from_url
    def validate(value): result = original(value); entered.set(); return result
    monkeypatch.setattr(config, "from_url", validate)
    read = Mock(wraps=config._read_snapshot); monkeypatch.setattr(config, "_read_snapshot", read)
    before = studio.path.read_bytes()
    with ThreadPoolExecutor(max_workers=1) as pool:
        with config.LOCK:
            pending = pool.submit(client.post, PATHS[1], json={"url": NEW["chat_url"]})
            assert entered.wait(5)
            S.revoke_session_token(token)
        result = pending.result(5)
    assert result.status_code == 401
    read.assert_not_called(); assert_old(studio, before)


@pytest.mark.parametrize("phase", ["send", "chunk", "close"])
@pytest.mark.parametrize("failure", [False, True], ids=["returned", "failed"])
@pytest.mark.parametrize("kind,status", [("revoke", 401), ("security-unavailable", 503)])
def test_probe_rechecks_after_external_work_and_hides_model_or_error(studio, phase, failure, kind, status):
    client, token = studio.browser(); before = studio.path.read_bytes()
    def lose():
        studio.lose(token, kind)
        if failure: raise OSError("PRIVATE model failure")
    if phase == "send":
        def send(*args, **kwargs): lose(); return studio.response
        studio.session.get.side_effect = send
    elif phase == "chunk":
        def chunks(**kwargs):
            lose(); yield b'{"data":[{"id":"PRIVATE model"}]}'
            pytest.fail("No additional body read after authority loss")
        studio.response.iter_content.side_effect = chunks
    else: studio.response.close.side_effect = lose
    result = client.post(PATHS[0], json={"url": NEW["chat_url"]})
    assert result.status_code == status and "PRIVATE" not in result.text
    assert result.headers["cache-control"] == "no-store"
    assert studio.session.get.call_count == 1
    if phase != "send" or not failure: studio.response.close.assert_called_once()
    assert_old(studio, before)


@pytest.mark.parametrize("body", [b"{", b"[]", b'{"data":{}}', b'{"data":[null]}', b'{"data":[{"id":5}]}',
                                   b'{"data":[{"id":"\\ud800"}]}', json.dumps({"data": [{}] * 1001}).encode()],
                         ids=["json", "list", "mapping", "null-row", "id-type", "unicode", "row-limit"])
def test_invalid_upstream_models_never_claim_success_or_expose_raw_body(studio, body):
    client, _ = studio.browser()
    studio.response.iter_content.return_value = iter([body])
    result = client.post(PATHS[0], json={"url": NEW["chat_url"]})
    assert result.status_code == 200 and result.json()["ok"] is False
    assert set(result.json()) == {"ok", "error"} and "PRIVATE" not in result.text
    studio.response.close.assert_called_once()


@pytest.mark.parametrize("status", [302, 401, 500])
def test_upstream_error_does_not_read_body_or_follow_destination(studio, status):
    client, _ = studio.browser(); studio.response.status_code = status
    result = client.post(PATHS[0], json={"url": NEW["chat_url"]})
    assert result.status_code == 200 and result.json()["ok"] is False
    studio.response.iter_content.assert_not_called(); studio.response.close.assert_called_once()
    assert studio.session.get.call_count == 1 and studio.session.get.call_args.kwargs["allow_redirects"] is False


@pytest.mark.parametrize("path", PATHS)
def test_validation_result_cannot_disclose_or_continue_after_pin_off_cycle(studio, monkeypatch, path):
    client, _ = studio.browser("open-local"); before = studio.path.read_bytes(); original = config.from_url
    def validate(value):
        result = original(value)
        S.revoke_all_sessions()
        return result
    monkeypatch.setattr(config, "from_url", validate)
    result = client.post(path, json={"url": NEW["chat_url"]})
    assert result.status_code == 401
    studio.factory.assert_not_called(); assert_old(studio, before)
