"""Private model observations: real browser checks, synthetic transports only."""
import json
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest
import requests

import model_probe
from providers.lmstudio import LMStudioProvider
from routers import system_routes as routes
import shelly_store
import tli_state as S


PATHS = ["/health/llm", "/health/llm/report", "/health/lmstudio/report",
         "/models/available", "/setup/autodetect"]


@pytest.fixture
def observed(tmp_path, monkeypatch):
    cfg = {"enabled": True}
    monkeypatch.setattr(S, "load_pin_config", lambda: dict(cfg))
    monkeypatch.setattr(S, "_active_sessions", {})
    token = S.create_session_token("owner")
    log = Mock()
    provider = LMStudioProvider("https://model.invalid/prefix/v1/chat/completions",
                                "https://model.invalid/prefix/v1/models", debug_log=log)
    monkeypatch.setattr(S, "lm_provider", provider)
    monkeypatch.setattr(S, "LM_STUDIO_URL", provider.chat_url)
    monkeypatch.setattr(S, "MODEL_CONFIG", {"chosen": {"id": "private-model"}})
    monkeypatch.setattr(S, "DEFAULT_MODEL_KEY", "chosen")
    monkeypatch.setattr(routes, "_report_cache", {"result": None, "ts": 0, "provider": None})
    monkeypatch.setattr(routes, "_health_cache", {"result": False, "ts": 0, "provider": None})
    monkeypatch.setattr(S, "SHELLY_REGISTRY_PATH", tmp_path / "shelly.json")
    monkeypatch.setattr(shelly_store, "_SEEN", set())
    node = Mock(return_value=SimpleNamespace(node_name="Private host", node_id="private-node", role="standalone"))
    lan = Mock(return_value="192.0.2.33")
    monkeypatch.setattr(S, "read_node_config", node)
    original_lan = routes._get_lan_ip
    monkeypatch.setattr(routes, "_get_lan_ip", lan)
    f = SimpleNamespace(cfg=cfg, token=token, provider=provider, log=log, node=node, lan=lan,
                        sessions=[], responses=[], calls=[], send_hook=None, body_hook=None,
                        model_data={"data": [{"id": "private-model"}]},
                        chat_data={"choices": [{"message": {"content": "private-generated-text"}}]},
                        status=200, path=S.SHELLY_REGISTRY_PATH, original_lan=original_lan)

    class Response:
        def __init__(self, method, url):
            self.method, self.url = method, url
            self.status_code = f.status
            self.headers = {"server": "private-provider"}
            self.close = Mock()
            self.data = f.model_data if method == "GET" else f.chat_data

        def iter_content(self, chunk_size):
            yield json.dumps(self.data).encode()
            if f.body_hook:
                f.body_hook(self)

    class Session:
        def __init__(self):
            self.trust_env = True
            self.closed = False
            f.sessions.append(self)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            self.closed = True

        def send(self, method, url, **kwargs):
            f.calls.append((method, url, kwargs))
            response = Response(method, url)
            f.responses.append(response)
            if f.send_hook:
                f.send_hook(response)
            return response

        def get(self, url, **kwargs):
            return self.send("GET", url, **kwargs)

        def post(self, url, **kwargs):
            return self.send("POST", url, **kwargs)

    monkeypatch.setattr(model_probe.requests, "Session", Session)
    app = FastAPI()
    app.include_router(routes.router)
    clients = []

    def client(*, base="https://host.test", peer="192.0.2.20", cookie=True, headers=None):
        value = TestClient(app, base_url=base, client=(peer, 1234),
                           headers={"Origin": base, **(headers or {})},
                           cookies={"tli_session": token} if cookie else {},
                           raise_server_exceptions=False)
        clients.append(value)
        return value

    f.client = client
    yield f
    for value in clients:
        value.close()


DENIED = [("anonymous", 401), ("revoked", 401), ("expired", 401),
          ("foreign-origin", 403), ("foreign-fetch", 403), ("remote-http", 403),
          ("pin-off-remote", 403), ("pin-off-stale", 401), ("bearer", 403),
          ("peer", 403), ("proxy", 403), ("unavailable-pin", 503)]


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("mode,status", DENIED)
def test_model_observations_deny_before_provider_or_private_state(observed, monkeypatch, path, mode, status):
    f = observed
    options = {}
    if mode == "anonymous":
        options["cookie"] = False
    elif mode in {"revoked", "pin-off-stale"}:
        S.revoke_session_token(f.token)
        if mode == "pin-off-stale":
            f.cfg["enabled"] = False
            options.update(base="http://localhost", peer="127.0.0.1")
    elif mode == "expired":
        S._active_sessions[f.token]["expiry"] = 0
    elif mode == "foreign-origin":
        options["headers"] = {"Origin": "https://foreign.invalid"}
    elif mode == "foreign-fetch":
        options["headers"] = {"Sec-Fetch-Site": "cross-site"}
    elif mode == "remote-http":
        options["base"] = "http://host.test"
    elif mode == "pin-off-remote":
        f.cfg["enabled"] = False
        options["cookie"] = False
    elif mode == "bearer":
        options["headers"] = {"Authorization": "Bearer synthetic-device"}
    elif mode == "peer":
        options["headers"] = {"X-TLI-Peer-Id": "synthetic-peer"}
    elif mode == "proxy":
        options["headers"] = {"X-Forwarded-For": "127.0.0.1"}
    else:
        monkeypatch.setattr(S, "load_pin_config", Mock(side_effect=HTTPException(503, "Unavailable")))
    read = Mock(side_effect=AssertionError("Private store reached"))
    monkeypatch.setattr(shelly_store, "read", read)
    response = f.client(**options).get(path)
    assert response.status_code == status, response.text
    assert response.headers["cache-control"] == "no-store"
    assert f.calls == [] and f.sessions == []
    assert f.provider._report_cache == {"ts": 0.0, "report": None}
    for probe in (read, f.node, f.lan, f.log):
        probe.assert_not_called()


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("mode", ["remote-browser", "local-browser", "open-local"])
def test_model_observations_support_browser_modes_and_bounded_transport(observed, path, mode):
    f = observed
    options = {}
    if mode != "remote-browser":
        options.update(base="http://localhost", peer="127.0.0.1")
    if mode == "open-local":
        f.cfg["enabled"] = False
        options["cookie"] = False
    response = f.client(**options).get(path)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    if path == PATHS[0]:
        assert response.json() == {"ok": True}
    elif path == PATHS[3]:
        assert response.json()["models"] == [{"id": "private-model", "label": "private-model"}]
        assert response.json()["server_url"] == f.provider.models_url
    elif path == PATHS[4]:
        assert response.json()["ai"]["models"] == ["private-model"]
        assert response.json()["node"]["node_id"] == "private-node"
    else:
        assert response.json()["chat_ok"] is True
        assert response.json()["model_count"] == 1
    assert "private-generated-text" not in response.text
    assert all(session.closed and session.trust_env is False for session in f.sessions)
    assert all(response.close.call_count == 1 for response in f.responses)
    for method, url, kwargs in f.calls:
        assert kwargs["allow_redirects"] is False and kwargs["stream"] is True
        assert kwargs["headers"] == {"Accept": "application/json"}
        if method == "POST":
            assert kwargs["json"] == {"model": "private-model", "messages": [{"role": "user", "content": "ping"}],
                                      "max_tokens": 1, "temperature": 0}


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("change", ["revoke", "pin-epoch", "unavailable"])
@pytest.mark.parametrize("during_error", [False, True])
def test_model_observations_stop_after_first_response_or_error(observed, monkeypatch, path, change, during_error):
    f = observed
    # One fixed setup candidate makes the boundary deterministic; no real DNS or LAN.
    monkeypatch.setattr(routes, "_LM_PROBE_PORTS", routes._LM_PROBE_PORTS[:1])
    options = {}
    if change == "pin-epoch":
        f.cfg["enabled"] = False
        options.update(base="http://localhost", peer="127.0.0.1", cookie=False)

    def revoke(response):
        if change == "pin-epoch":
            S.revoke_all_sessions()
        elif change == "unavailable":
            monkeypatch.setattr(S, "load_pin_config", Mock(side_effect=HTTPException(503, "Unavailable")))
        else:
            S.revoke_session_token(f.token)
        if during_error:
            raise requests.ConnectionError("PRIVATE upstream credentials")

    if during_error:
        f.send_hook = revoke
    else:
        f.body_hook = revoke
    response = f.client(**options).get(path)
    assert response.status_code == (503 if change == "unavailable" else 401), response.text
    assert response.headers["cache-control"] == "no-store"
    assert len(f.calls) == 1 and f.calls[0][0] == "GET"
    assert "private" not in response.text.lower()
    assert f.provider._report_cache == {"ts": 0.0, "report": None}
    assert routes._report_cache["result"] is None
    f.log.assert_not_called()
    f.node.assert_not_called()
    f.lan.assert_not_called()
    assert all(session.closed for session in f.sessions)
    if not during_error:
        f.responses[0].close.assert_called_once()


@pytest.mark.parametrize("path", PATHS[:4])
def test_revoke_during_chat_probe_never_caches_or_discloses_completed_probe(observed, path):
    f = observed
    def revoke(response):
        if response.method == "POST":
            S.revoke_session_token(f.token)
    f.body_hook = revoke
    response = f.client().get(path)
    assert response.status_code == 401
    assert len([call for call in f.calls if call[0] == "POST"]) == 1
    assert f.provider._report_cache == {"ts": 0.0, "report": None}
    assert routes._report_cache["result"] is None
    f.log.assert_not_called()
    assert all(value.close.call_count == 1 for value in f.responses)


@pytest.mark.parametrize("path", PATHS[:3])
@pytest.mark.parametrize("cache", ["provider", "route"])
def test_cached_health_requires_current_browser_before_disclosure(observed, path, cache):
    f = observed
    report = {"ok": True, "chat_ok": True, "server_url": "PRIVATE cached endpoint"}
    if cache == "provider":
        f.provider._report_cache = {"ts": 10**12, "report": report}
    else:
        routes._report_cache = {"result": report, "ts": 10**12, "provider": f.provider}
    S.revoke_session_token(f.token)
    response = f.client().get(path)
    assert response.status_code == 401 and "PRIVATE" not in response.text
    assert f.calls == []


@pytest.mark.parametrize("method", ["health_report", "health_check", "list_models"])
def test_checked_provider_cannot_reuse_cached_state_after_denial(observed, method):
    f = observed
    f.provider._report_cache = {"ts": 10**12, "report": {"ok": True, "chat_ok": True}}
    error = HTTPException(401, "denied")
    with pytest.raises(HTTPException) as caught:
        getattr(f.provider, method)(check=Mock(side_effect=error))
    assert caught.value is error
    assert f.calls == []


@pytest.mark.parametrize("data", [None, [], {"data": {}}, {"data": ["model"]},
                                  {"data": [{"id": {"secret": "PRIVATE"}}]},
                                  {"data": [{"id": "m" * 1025}]},
                                  {"data": [{"id": "\ud800"}]},
                                  {"data": [{"id": "m"}] * 1001}])
@pytest.mark.parametrize("path", [PATHS[1], PATHS[3], PATHS[4]])
def test_invalid_model_shapes_are_bounded_and_never_become_chat_probe(observed, monkeypatch, data, path):
    f = observed
    monkeypatch.setattr(routes, "_LM_PROBE_PORTS", routes._LM_PROBE_PORTS[:1])
    f.model_data = data
    response = f.client().get(path)
    assert response.status_code == (502 if path == PATHS[3] else 200), response.text
    assert all(call[0] == "GET" for call in f.calls)
    assert "PRIVATE" not in response.text
    if path == PATHS[1]:
        assert response.json()["ok"] is False
    elif path == PATHS[4]:
        assert response.json()["ai"]["found"] is False


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize("status", [302, 500])
def test_upstream_errors_never_return_bodies_or_follow_redirects(observed, path, status):
    f = observed
    f.status = status
    f.model_data = {"error": "PRIVATE upstream response"}
    response = f.client().get(path)
    assert response.status_code == (502 if path == PATHS[3] else 200), response.text
    assert "PRIVATE" not in response.text
    assert all(call[0] == "GET" for call in f.calls)
    assert all(value.close.call_count == 1 for value in f.responses)


@pytest.mark.parametrize("stage", ["registry", "node", "lan"])
@pytest.mark.parametrize("source_error", [False, True])
def test_setup_checks_slow_private_reads_and_error_disclosure(observed, monkeypatch, stage, source_error):
    f = observed
    def revoke(*args, **kwargs):
        S.revoke_session_token(f.token)
        if source_error:
            raise OSError("PRIVATE read failure")
        return [] if stage == "registry" else f.node.return_value if stage == "node" else "192.0.2.34"
    if stage == "registry":
        monkeypatch.setattr(shelly_store, "read", revoke)
    else:
        getattr(f, stage).side_effect = revoke
    response = f.client().get(PATHS[4])
    assert response.status_code == 401 and "PRIVATE" not in response.text
    if stage == "registry":
        f.node.assert_not_called()
    if stage != "lan":
        f.lan.assert_not_called()


def test_setup_preserves_damaged_registry_without_fallback(observed, monkeypatch):
    f = observed
    f.path.write_bytes(b'{"private": broken')
    fallback = Mock(side_effect=AssertionError("Tolerant fallback used"))
    monkeypatch.setattr(S, "load_shelly_registry", fallback)
    response = f.client().get(PATHS[4])
    assert response.status_code == 503
    assert f.path.read_bytes() == b'{"private": broken'
    fallback.assert_not_called()
    f.node.assert_not_called()
    f.lan.assert_not_called()


def test_setup_missing_identity_does_not_create_one(observed, monkeypatch):
    f = observed
    f.node.return_value = None
    bootstrap = Mock(side_effect=AssertionError("Identity bootstrap reached"))
    save = Mock(side_effect=AssertionError("Identity write reached"))
    monkeypatch.setattr(S, "load_node_config", bootstrap)
    monkeypatch.setattr(S, "save_node_config", save)
    response = f.client().get(PATHS[4])
    assert response.status_code == 200
    assert response.json()["node"] == {"name": "TLI Node", "node_id": None, "role": "standalone"}
    bootstrap.assert_not_called()
    save.assert_not_called()


def test_models_uses_captured_provider_when_configuration_changes_mid_read(observed, monkeypatch):
    f = observed
    other = Mock()
    def switch(response):
        monkeypatch.setattr(S, "lm_provider", other)
    f.body_hook = switch
    response = f.client().get(PATHS[3])
    assert response.status_code == 200
    assert response.json()["server_url"] == f.provider.models_url
    assert response.json()["compat"]["server_url"] == f.provider.models_url
    other.list_models.assert_not_called()
    other.health_report.assert_not_called()


@pytest.mark.parametrize("path", PATHS[:4])
def test_revocation_during_logging_does_not_publish_health_cache(observed, path):
    f = observed
    f.log.side_effect = lambda *args, **kwargs: S.revoke_session_token(f.token)
    response = f.client().get(path)
    assert response.status_code == 401
    assert f.provider._report_cache == {"ts": 0.0, "report": None}
    assert routes._report_cache["result"] is None


@pytest.mark.parametrize("kind", ["provider", "report", "health"])
@pytest.mark.parametrize("concurrent_publication", [False, True])
def test_final_cache_denial_rolls_back_only_this_publication(observed, monkeypatch, kind, concurrent_publication):
    f = observed
    if kind == "provider":
        target, attr, call = f.provider, "_report_cache", f.provider.health_report
    else:
        target, attr = routes, "_report_cache" if kind == "report" else "_health_cache"
        call = routes.lmstudio_health_report_legacy if kind == "report" else routes.lm_studio_health_check_cached
        monkeypatch.setattr(f.provider, "health_report" if kind == "report" else "health_check",
                            lambda *, check=None: {"ok": True} if kind == "report" else True)
    previous = getattr(target, attr)
    other = {"ts": 123, "report": {"other": True}}
    denied = HTTPException(503, "Authority temporarily unavailable")

    def check():
        if getattr(target, attr) is not previous:
            if concurrent_publication:
                setattr(target, attr, other)
            raise denied

    with pytest.raises(HTTPException) as caught:
        call(check=check)
    assert caught.value is denied
    assert getattr(target, attr) is (other if concurrent_publication else previous)


@pytest.mark.parametrize("when", ["connect", "read", "error"])
def test_setup_lan_read_denies_after_socket_boundary(observed, monkeypatch, when):
    import socket
    f = observed
    sock = MagicMock()
    sock.__enter__.return_value = sock
    sock.__exit__.return_value = False
    sock.getsockname.return_value = ("192.0.2.22", 1234)
    factory = Mock(return_value=sock)
    monkeypatch.setattr(socket, "socket", factory)

    def revoke(*args):
        S.revoke_session_token(f.token)
        if when == "error":
            raise OSError("PRIVATE socket failure")
        return ("192.0.2.22", 1234)

    if when == "read":
        sock.getsockname.side_effect = revoke
    else:
        sock.connect.side_effect = revoke
    def check():
        if not S.validate_session_token(f.token):
            raise HTTPException(401, "Access revoked")
    with pytest.raises(HTTPException) as caught:
        f.original_lan(check=check)
    assert caught.value.status_code == 401
    if when != "read":
        sock.getsockname.assert_not_called()
    sock.__exit__.assert_called_once()


def test_lan_probe_never_converts_transient_authority_error_to_loopback(observed, monkeypatch):
    import socket
    sock = MagicMock()
    sock.__enter__.return_value = sock
    sock.__exit__.return_value = False
    monkeypatch.setattr(socket, "socket", Mock(return_value=sock))
    denied = HTTPException(503, "Authority temporarily unavailable")
    check = Mock(side_effect=[None, denied, None])
    with pytest.raises(HTTPException) as caught:
        observed.original_lan(check=check)
    assert caught.value is denied
    sock.connect.assert_not_called()
    sock.getsockname.assert_not_called()


@pytest.mark.parametrize("path", PATHS[:3])
@pytest.mark.parametrize("cache", ["provider", "route"])
def test_checked_endpoint_never_discloses_legacy_unbounded_cache(observed, path, cache):
    f = observed
    report = {"ok": True, "chat_ok": True, "error": "PRIVATE legacy token",
              "chat_error": "PRIVATE raw response", "server_header": "PRIVATE" * 5000}
    if cache == "provider":
        f.provider._report_cache = {"ts": 10**12, "report": report}
    else:
        routes._report_cache = {"result": report, "ts": 10**12, "provider": f.provider}
    response = f.client().get(path)
    assert response.status_code == 200
    assert "PRIVATE" not in response.text
    assert len(f.calls) == 2
    assert f.provider._report_cache["checked"] is True


@pytest.mark.parametrize("path", PATHS[:3])
def test_checked_health_cache_can_be_reused_with_live_authority(observed, path):
    f = observed
    client = f.client()
    first = client.get(path)
    second = client.get(path)
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert len(f.calls) == 2


def test_legacy_refresh_cannot_keep_checked_cache_provenance(observed, monkeypatch):
    f = observed
    f.provider._report_cache = {"ts": 0, "report": {"ok": True}, "checked": True}
    monkeypatch.setattr(requests, "get", Mock(side_effect=RuntimeError("PRIVATE legacy exception")))
    legacy = f.provider.health_report()
    assert legacy["error"] == "PRIVATE legacy exception"
    assert f.provider._report_cache.get("checked") is not True
    response = f.client().get(PATHS[1])
    assert response.status_code == 200 and "PRIVATE" not in response.text
    assert len(f.calls) == 2


def test_setup_latches_other_worker_authority_failure_after_first_hit(observed, monkeypatch):
    from concurrent.futures import Future
    import concurrent.futures
    f = observed
    denied = HTTPException(503, "PIN temporarily unavailable")
    transient = {"deny": False}
    def pin():
        if transient["deny"]:
            raise denied
        return dict(f.cfg)
    monkeypatch.setattr(S, "load_pin_config", pin)
    candidates = [("first", "http://localhost:1/models", "http://localhost:1/chat"),
                  ("later", "http://localhost:2/models", "http://localhost:2/chat")]
    monkeypatch.setattr(routes, "_LM_PROBE_PORTS", candidates)
    completed = []

    def probe(url, chat, label, *, check):
        if label == "later":
            transient["deny"] = True
            try:
                check()
            finally:
                transient["deny"] = False
        check()
        return {"chat_url": chat, "label": label, "models": ["PRIVATE"]}
    monkeypatch.setattr(routes, "_probe_lm", probe)

    class Pool:
        def __init__(self, **kwargs):
            self.pending = []

        def __enter__(self):
            return self

        def submit(self, fn, *args, **kwargs):
            future = Future()
            future.set_running_or_notify_cancel()
            if not completed:
                future.set_result(fn(*args, **kwargs))
                completed.append(future)
            else:
                self.pending.append((future, fn, args, kwargs))
            return future

        def __exit__(self, *args):
            for future, fn, args, kwargs in self.pending:
                try:
                    future.set_result(fn(*args, **kwargs))
                except Exception as error:
                    future.set_exception(error)
                completed.append(future)

    monkeypatch.setattr(concurrent.futures, "ThreadPoolExecutor", Pool)
    response = f.client().get(PATHS[4])
    assert response.status_code == 503 and "PRIVATE" not in response.text
    assert completed[-1].exception() is denied
    f.node.assert_not_called()
    f.lan.assert_not_called()


def test_cache_replacement_cannot_lend_checked_marker_to_old_raw_report(observed):
    f = observed
    raw = {"ok": True, "error": "PRIVATE legacy exception"}
    checked = {"ts": 10**12, "report": {"ok": True}, "checked": True}
    class ChangedCache(dict):
        def get(self, key, default=None):
            if key == "report":
                f.provider._report_cache = checked
            return super().get(key, default)
    f.provider._report_cache = ChangedCache(ts=10**12, report=raw)
    response = f.client().get(PATHS[1])
    assert response.status_code == 200 and "PRIVATE" not in response.text
    assert len(f.calls) == 2


def test_legacy_refresh_publishes_without_mutating_old_checked_snapshot(observed, monkeypatch):
    f = observed
    previous = {"ts": 0, "report": {"ok": True}, "checked": True}
    f.provider._report_cache = previous
    monkeypatch.setattr(requests, "get", Mock(side_effect=RuntimeError("PRIVATE legacy error")))
    result = f.provider.health_report()
    assert result["error"] == "PRIVATE legacy error"
    assert previous == {"ts": 0, "report": {"ok": True}, "checked": True}
    assert f.provider._report_cache is not previous
    assert f.provider._report_cache.get("checked") is not True
